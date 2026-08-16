//! SilentEdge non-custodial trading vault.
//!
//! # The custody invariant
//!
//! Funds leave a vault by exactly two paths:
//!
//!   1. a swap between two allowlisted mints, where both sides stay inside the
//!      same vault (arrives with the trading phases);
//!   2. a withdrawal to `VaultConfig.owner`, signed by the owner.
//!
//! There is no third path, and **no instruction accepts an operator authority**.
//! That is a property of this instruction set, not a runtime check — the reason
//! the operator cannot steal is that no instruction exists that would let them.
//!
//! Two rules that look like details and are not:
//!
//!   * `withdraw` never inspects `status`. Pausing must never trap user funds.
//!   * `withdraw`'s destination is derived from `vault_config.owner`, never
//!     passed in. A destination parameter is a rug waiting for a bug.
//!
//! See ARCHITECTURE.md §4 and THREAT_MODEL.md T-1..T-6.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

pub mod constants;
pub mod errors;
pub mod oracle;
pub mod state;

pub use constants::*;
pub use errors::VaultError;
pub use oracle::*;
pub use state::*;

const COMP_DEF_OFFSET_STORE_STRATEGY: u32 = comp_def_offset("store_strategy_v2");
const COMP_DEF_OFFSET_EVALUATE_STRATEGY: u32 = comp_def_offset("evaluate_strategy_v3");

declare_id!("J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ");

#[arcium_program]
pub mod vault {
    use super::*;

    /// Create a vault and its two program-owned token accounts.
    pub fn initialize_vault(ctx: Context<InitializeVault>, limits: RiskLimits) -> Result<()> {
        limits.validate()?;

        let vault_config = &mut ctx.accounts.vault_config;
        vault_config.owner = ctx.accounts.owner.key();
        vault_config.base_mint = ctx.accounts.base_mint.key();
        vault_config.quote_mint = ctx.accounts.quote_mint.key();
        vault_config.limits = limits;
        vault_config.status = VaultStatus::Active;
        vault_config.bump = ctx.bumps.vault_config;
        vault_config.nonce = 0;
        vault_config.last_trade_ts = 0;
        vault_config.max_base_exposure_bps = 0;
        vault_config.min_trade_bps = 0;
        vault_config.listed = false;
        vault_config.name = [0u8; 32];
        vault_config.reserved = [0u8; 25];

        emit!(VaultInitialized {
            vault: vault_config.key(),
            owner: vault_config.owner,
            base_mint: vault_config.base_mint,
            quote_mint: vault_config.quote_mint,
        });
        Ok(())
    }

    /// Replace the vault's risk envelope. Owner only.
    ///
    /// Limits were write-once, and the vault PDA is one-per-owner with no close
    /// instruction — so a cooldown or trade cap set badly at creation was
    /// permanent for that vault, with no way out but abandoning it. That is only
    /// tolerable while the limits are inert; it stops being tolerable the moment
    /// they are enforced.
    ///
    /// Bumps `nonce`, which invalidates any authorization already in flight. An
    /// intent carries no copy of the envelope it was issued under, so without
    /// the bump a decision made under the old limits would execute under the new
    /// ones. There is no timelock and no tighten-only ratchet on purpose: both
    /// would guard a strictly weaker path than `withdraw`, which sends 100% to
    /// the owner with no delay and no cap. A stolen owner key does not need this
    /// instruction.
    pub fn update_limits(ctx: Context<UpdateLimits>, limits: RiskLimits) -> Result<()> {
        limits.validate()?;
        require!(
            ctx.accounts.vault_config.status != VaultStatus::Stopped,
            VaultError::VaultStopped
        );

        let vault = &mut ctx.accounts.vault_config;
        vault.limits = limits;
        vault.nonce = vault.nonce.checked_add(1).ok_or(VaultError::Overflow)?;

        emit!(LimitsUpdated {
            vault: vault.key(),
            nonce: vault.nonce,
        });
        Ok(())
    }

    /// List or unlist this vault in public discovery. Owner only.
    ///
    /// Listing changes what is *findable*, never what is readable. Everything a
    /// listing surfaces — balances, limits, trade history — was already public
    /// on chain; the encrypted strategy stays encrypted, because no instruction
    /// in this program can export it.
    ///
    /// Deliberately not gated on having a strategy or a balance: an owner may
    /// want to unlist instantly, and adding conditions to that is adding ways
    /// for it to fail when it matters.
    pub fn set_listing(ctx: Context<SetListing>, listed: bool, name: [u8; 32]) -> Result<()> {
        let vault = &mut ctx.accounts.vault_config;
        vault.listed = listed;
        vault.name = name;

        emit!(ListingChanged {
            vault: vault.key(),
            listed,
        });
        Ok(())
    }

    /// Set the concentration ceiling and the minimum trade size. Owner only.
    ///
    /// A separate instruction rather than two more fields on `RiskLimits`,
    /// because `RiskLimits` sits in the middle of `VaultConfig` — adding to it
    /// shifts the offset of every field after it and strands every existing
    /// vault, which is exactly the mistake this codebase already made once and
    /// documented at `VaultConfig::reserved`.
    ///
    /// Both default to 0, meaning disabled, which is what a vault created
    /// before these existed reads out of zeroed reserve bytes.
    pub fn set_exposure_limits(
        ctx: Context<UpdateLimits>,
        max_base_exposure_bps: u16,
        min_trade_bps: u16,
    ) -> Result<()> {
        require!(
            max_base_exposure_bps <= BPS_DENOMINATOR,
            VaultError::InvalidRiskLimit
        );
        // A minimum above the per-trade cap would refuse every trade the
        // strategy could ever size, which is a bricked vault rather than a
        // conservative one.
        require!(
            min_trade_bps <= ctx.accounts.vault_config.limits.max_trade_bps,
            VaultError::InvalidRiskLimit
        );

        let vault = &mut ctx.accounts.vault_config;
        vault.max_base_exposure_bps = max_base_exposure_bps;
        vault.min_trade_bps = min_trade_bps;
        vault.nonce = vault.nonce.checked_add(1).ok_or(VaultError::Overflow)?;

        emit!(LimitsUpdated {
            vault: vault.key(),
            nonce: vault.nonce,
        });
        Ok(())
    }

    /// Follow a listed vault by copying its encrypted strategy into your own.
    ///
    /// # Why copying the ciphertext is safe
    ///
    /// `Enc<Mxe, Strategy>` is encrypted to the *cluster*, not to a person. The
    /// follower ends up holding bytes they cannot decrypt, and which were
    /// already published on the leader's account — copying them discloses
    /// nothing that was not already on chain. The cluster can evaluate them
    /// wherever they sit, so the follower's vault becomes evaluable without
    /// anyone learning a threshold.
    ///
    /// # What the follower keeps
    ///
    /// Their own limits, their own balances, their own vault. The copied
    /// strategy decides the *side*; `size_bps`, `max_trade_bps`, the cooldown
    /// and the slippage floor are all read from the follower's own config at
    /// evaluation and execution. Following someone does not adopt their risk
    /// appetite, and cannot be used to route around your own limits.
    ///
    /// Requires the leader to be listed. Listing is the owner's explicit,
    /// revocable statement that the vault is public; without it this would let
    /// anyone copy a strategy from a vault that never offered one.
    pub fn copy_strategy(ctx: Context<CopyStrategy>) -> Result<()> {
        let leader = &ctx.accounts.leader_strategy;
        require!(
            ctx.accounts.leader_vault.listed,
            VaultError::VaultNotListed
        );
        require!(
            ctx.accounts.vault_config.key() != ctx.accounts.leader_vault.key(),
            VaultError::CannotFollowSelf
        );
        // Only a converted strategy is evaluable; copying an unconverted one
        // would produce a follower vault that silently never trades.
        require!(leader.mxe_version > 0, VaultError::StrategyNotConverted);
        require!(
            ctx.accounts.vault_config.status != VaultStatus::Stopped,
            VaultError::VaultStopped
        );

        let follower = &mut ctx.accounts.strategy_state;
        follower.vault = ctx.accounts.vault_config.key();
        follower.mxe_ciphertexts = leader.mxe_ciphertexts;
        follower.mxe_nonce = leader.mxe_nonce;
        follower.version = follower.version.checked_add(1).ok_or(VaultError::Overflow)?;
        follower.mxe_version = follower.mxe_version.checked_add(1).ok_or(VaultError::Overflow)?;
        follower.bump = ctx.bumps.strategy_state;
        follower.follows = ctx.accounts.leader_vault.key();

        emit!(StrategyCopied {
            vault: follower.vault,
            leader: ctx.accounts.leader_vault.key(),
            version: follower.mxe_version,
        });
        Ok(())
    }

    /// Move tokens from the owner's wallet into the vault.
    ///
    /// Blocked unless the vault is `Active`: if a vault is paused or stopped,
    /// something is wrong with it and it should not be taking more money.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(
            ctx.accounts.vault_config.status == VaultStatus::Active,
            VaultError::VaultNotActive
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    to: ctx.accounts.vault_ata.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(Deposited {
            vault: ctx.accounts.vault_config.key(),
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }

    /// Move tokens from the vault back to the owner.
    ///
    /// Deliberately ignores `status`. A paused, stopped, or otherwise broken
    /// vault must still let its owner out — see THREAT_MODEL.md T-4 and §8.1.
    /// Touches no Arcium account, so this keeps working if the MPC network,
    /// our backend, and our executor are all unavailable.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(
            ctx.accounts.vault_ata.amount >= amount,
            VaultError::InsufficientBalance
        );

        let owner = ctx.accounts.vault_config.owner;
        let bump = ctx.accounts.vault_config.bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.vault_config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(Withdrawn {
            vault: ctx.accounts.vault_config.key(),
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }

    /// Store an encrypted strategy for a vault, or replace the existing one.
    ///
    /// The program validates shape and authority, never content. It has no way
    /// to read the ciphertext and no reason to: the whole point is that the
    /// operator running this program learns nothing from it.
    ///
    /// Uses `init_if_needed` because submitting is create-or-replace. The usual
    /// re-initialization risk does not apply here — the account is seeded by the
    /// vault, the vault is seeded by the owner, and the owner must sign, so no
    /// one else can reach it.
    pub fn submit_strategy(
        ctx: Context<SubmitStrategy>,
        ciphertexts: [[u8; 32]; STRATEGY_FIELDS],
        nonce: u128,
        encryption_pubkey: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.vault_config.status != VaultStatus::Stopped,
            VaultError::VaultStopped
        );
        // An all-zero key means no usable key exchange, so the MXE could never
        // derive the shared secret. Cheap to catch here, confusing later.
        require!(
            encryption_pubkey != [0u8; 32],
            VaultError::InvalidEncryptionKey
        );

        let strategy = &mut ctx.accounts.strategy_state;
        strategy.vault = ctx.accounts.vault_config.key();
        strategy.ciphertexts = ciphertexts;
        strategy.nonce = nonce;
        strategy.encryption_pubkey = encryption_pubkey;
        strategy.version = strategy.version.checked_add(1).ok_or(VaultError::Overflow)?;
        strategy.bump = ctx.bumps.strategy_state;
        strategy.follows = Pubkey::default();
        strategy.reserved = [0u8; 0];

        // Deliberately carries no ciphertext: an event is a public log, and
        // there is no reason to publish the payload twice.
        emit!(StrategySubmitted {
            vault: strategy.vault,
            version: strategy.version,
        });
        Ok(())
    }

    /// Create the account a verified callback will write authorizations into.
    pub fn init_trade_intent(ctx: Context<InitTradeIntent>) -> Result<()> {
        let intent = &mut ctx.accounts.trade_intent;
        intent.vault = ctx.accounts.vault_config.key();
        intent.consumed = true; // nothing authorized yet
        intent.bump = ctx.bumps.trade_intent;
        Ok(())
    }

    /// Consume a trade authorization.
    ///
    /// Callable by anyone. That is safe because the executor holds no privilege:
    /// every parameter of the trade is already fixed in `TradeIntent`, and every
    /// rule is checked here against on-chain state rather than against anything
    /// the caller supplies. The executor chooses only whether and when to submit
    /// inside the window — a liveness role, not a trust role. Users can always
    /// self-execute, so a vanished operator cannot strand them.
    ///
    /// What this cannot do, by construction rather than by check: withdraw,
    /// choose a destination, change the vault owner, change the strategy, call
    /// an arbitrary program, or exceed the vault's own limits.
    ///
    /// The swap itself lands in the trading phase. Everything before it — the
    /// authorization checks — is here, because that is the part that has to be
    /// right before any funds move.
    pub fn execute_trade<'info>(
        ctx: Context<'info, ExecuteTrade<'info>>,
        route_data: Vec<u8>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let vault = &ctx.accounts.vault_config;
        let intent = &ctx.accounts.trade_intent;

        require!(vault.status == VaultStatus::Active, VaultError::VaultNotActive);

        // Replay protection, layered on purpose. Any one of these would mostly
        // work; together they fail safe if one is ever wrong.
        require!(!intent.consumed, VaultError::IntentAlreadyConsumed);
        require!(intent.amount_in > 0, VaultError::NoTradeAuthorized);
        require!(
            intent.vault_nonce == vault.nonce,
            VaultError::IntentStale
        );
        require!(
            intent.strategy_version == ctx.accounts.strategy_state.mxe_version,
            VaultError::IntentStrategyMismatch
        );
        require!(
            clock.slot <= intent.expires_at_slot,
            VaultError::IntentExpired
        );

        let side = intent.side;
        let amount_in = intent.amount_in;
        let max_slippage_bps = vault.limits.max_slippage_bps;
        let max_trade_bps = vault.limits.max_trade_bps;
        let cooldown_seconds = vault.limits.cooldown_seconds;

        // Which ATA funds the swap depends on the direction. Getting this
        // backwards would size a sell against the wrong balance.
        let (src_before, dst_before) = match side {
            SIDE_BUY => (
                ctx.accounts.vault_quote_ata.amount,
                ctx.accounts.vault_base_ata.amount,
            ),
            SIDE_SELL => (
                ctx.accounts.vault_base_ata.amount,
                ctx.accounts.vault_quote_ata.amount,
            ),
            _ => return err!(VaultError::UnknownSide),
        };
        require!(
            src_before >= amount_in,
            VaultError::InsufficientSourceBalance
        );

        // A trade too small to matter still costs a transaction and a spread.
        // Applied to both sides: a dust exit is as wasteful as a dust entry.
        let min_trade_bps = vault.min_trade_bps;
        if min_trade_bps > 0 {
            let floor = (src_before as u128)
                .checked_mul(min_trade_bps as u128)
                .ok_or(VaultError::Overflow)?
                / BPS_DENOMINATOR as u128;
            require!(amount_in as u128 >= floor, VaultError::TradeTooSmall);
        }

        // The vault's own cap, applied to the balance actually being spent — on
        // entries only.
        //
        // A stop exits the whole position, so `amount_in == src_before`, while
        // the cap can never exceed 50% (MAX_TRADE_BPS_CEILING). Applying it to
        // sells therefore rejected *every* stop-loss with TradeTooLarge: the
        // vault's only downside control could not fire. The cap exists to bound
        // how much a single decision can put at risk, and a sell reduces risk —
        // its value is already bounded by the oracle-derived `min_out` below.
        // So exits are uncapped and entries are not.
        if side == SIDE_BUY {
            let max_trade = (src_before as u128)
                .checked_mul(max_trade_bps as u128)
                .ok_or(VaultError::Overflow)?
                .checked_div(BPS_DENOMINATOR as u128)
                .ok_or(VaultError::Overflow)? as u64;
            require!(amount_in <= max_trade, VaultError::TradeTooLarge);

            // Same reasoning for the cooldown: it throttles entries, never the
            // way out. Gating sells would let anyone burn the window on a benign
            // trade and lock out a de-risking exit, since execute_trade is
            // permissionless.
            let elapsed = clock
                .unix_timestamp
                .saturating_sub(ctx.accounts.vault_config.last_trade_ts);
            require!(
                elapsed >= cooldown_seconds as i64,
                VaultError::CooldownActive
            );
        }

        // A fresh oracle read at execution time, not the one the decision used,
        // and the floor the swap must clear.
        let price = read_sol_usd_price(&ctx.accounts.price_update)?;
        let min_out = oracle_min_out(side, amount_in, &price, max_slippage_bps)?;

        // Concentration ceiling, on entries only. Priced with the same oracle
        // read the floor uses, so a manipulated price cannot slip past it.
        //
        // `max_trade_bps` bounds one trade; this bounds the sum of them. A rule
        // like "buy below $150" keeps firing all the way down, so without a
        // ceiling a falling market converts the whole vault into the falling
        // asset, each trade individually within its cap.
        if side == SIDE_BUY && ctx.accounts.vault_config.max_base_exposure_bps > 0 {
            let base_after = ctx
                .accounts
                .vault_base_ata
                .amount
                .checked_add(min_out)
                .ok_or(VaultError::Overflow)?;
            let base_value = oracle_min_out(SIDE_SELL, base_after, &price, 0)?;
            let quote_after = src_before
                .checked_sub(amount_in)
                .ok_or(VaultError::Overflow)?;
            let total = (base_value as u128)
                .checked_add(quote_after as u128)
                .ok_or(VaultError::Overflow)?;
            let ceiling = total
                .checked_mul(ctx.accounts.vault_config.max_base_exposure_bps as u128)
                .ok_or(VaultError::Overflow)?
                / BPS_DENOMINATOR as u128;
            require!(
                (base_value as u128) <= ceiling,
                VaultError::ExposureLimitReached
            );
        }

        let vault_key = ctx.accounts.vault_config.key();
        let lamports_before = ctx.accounts.vault_config.to_account_info().lamports();

        // --- the swap ---
        //
        // The route is opaque to us: Jupiter's instruction data and its account
        // list both come from the caller. What makes that safe is not trusting
        // the route, it is that the program id is pinned and the vault's own
        // balances are asserted afterwards. The route may do anything it likes
        // so long as exactly `amount_in` leaves the source ATA and at least
        // `min_out` arrives in the destination ATA.
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                // The vault PDA is the swap's transfer authority. It cannot sign
                // the outer transaction, so it is signed for here instead.
                is_signer: *a.key == vault_key,
                is_writable: a.is_writable,
            })
            .collect();

        let ix = Instruction {
            program_id: JUPITER_PROGRAM_ID,
            accounts: metas,
            data: route_data,
        };

        let owner = ctx.accounts.vault_config.owner;
        let bump = ctx.accounts.vault_config.bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];

        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.jupiter_program.to_account_info());
        invoke_signed(&ix, &infos, &[seeds])?;

        // --- what the swap was allowed to do ---
        ctx.accounts.vault_quote_ata.reload()?;
        ctx.accounts.vault_base_ata.reload()?;
        let (src_after, dst_after) = match side {
            SIDE_BUY => (
                ctx.accounts.vault_quote_ata.amount,
                ctx.accounts.vault_base_ata.amount,
            ),
            _ => (
                ctx.accounts.vault_base_ata.amount,
                ctx.accounts.vault_quote_ata.amount,
            ),
        };

        // Exactly the authorized amount left, and it left the right account.
        require!(
            src_before.saturating_sub(src_after) == amount_in,
            VaultError::UnexpectedSourceDelta
        );
        // The proceeds landed in this vault, not somewhere else.
        require!(
            dst_after.saturating_sub(dst_before) >= min_out,
            VaultError::SlippageExceeded
        );
        // Rent is not a funding source for a swap.
        require!(
            ctx.accounts.vault_config.to_account_info().lamports() == lamports_before,
            VaultError::VaultLamportsChanged
        );

        let amount_out = dst_after.saturating_sub(dst_before);

        let intent = &mut ctx.accounts.trade_intent;
        intent.consumed = true;
        intent.oracle_price = price.price;
        intent.min_amount_out = min_out;

        let vault = &mut ctx.accounts.vault_config;
        vault.nonce = vault.nonce.checked_add(1).ok_or(VaultError::Overflow)?;
        vault.last_trade_ts = clock.unix_timestamp;

        emit!(TradeExecuted {
            vault: vault.key(),
            side,
            amount_in,
            amount_out,
            min_amount_out: min_out,
            oracle_price: price.price,
        });
        Ok(())
    }

    // ---------------------------------------------------------------
    // Confidential evaluation
    // ---------------------------------------------------------------

    pub fn init_store_strategy_comp_def(ctx: Context<InitStoreStrategyCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_evaluate_strategy_comp_def(
        ctx: Context<InitEvaluateStrategyCompDef>,
    ) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Re-encrypt the submitted strategy from `Enc<Shared, _>` to `Enc<Mxe, _>`.
    ///
    /// Owner-signed: this reads the strategy the owner submitted and hands it to
    /// the cluster. Evaluation afterwards needs nobody online.
    pub fn convert_strategy(ctx: Context<ConvertStrategy>, computation_offset: u64) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let strategy = &ctx.accounts.strategy_state;
        require!(strategy.version > 0, VaultError::NoStrategyStored);

        let args = ArgBuilder::new()
            .x25519_pubkey(strategy.encryption_pubkey)
            .plaintext_u128(strategy.nonce)
            .encrypted_u64(strategy.ciphertexts[0])
            .encrypted_u64(strategy.ciphertexts[1])
            .encrypted_u64(strategy.ciphertexts[2])
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![StoreStrategyV2Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.strategy_state.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "store_strategy_v2")]
    pub fn store_strategy_v2_callback(
        ctx: Context<StoreStrategyV2Callback>,
        output: SignedComputationOutputs<StoreStrategyV2Output>,
    ) -> Result<()> {
        // Cluster pinning: this is the trust boundary. See ARCHITECTURE §7.1.
        require!(
            ctx.accounts.cluster_account.key() == expected_cluster(),
            VaultError::UnexpectedCluster
        );

        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(StoreStrategyV2Output { field_0 }) => field_0,
            Err(_) => return Err(VaultError::AbortedComputation.into()),
        };

        let strategy = &mut ctx.accounts.strategy_state;
        strategy.mxe_ciphertexts = o.ciphertexts;
        strategy.mxe_nonce = o.nonce;
        strategy.mxe_version = strategy.version;

        emit!(StrategyConverted {
            vault: strategy.vault,
            version: strategy.mxe_version,
        });
        Ok(())
    }

    /// Evaluate the strategy against the live oracle price.
    ///
    /// Permissionless by design. Evaluation reveals nothing, authorizes nothing
    /// on its own, and a permissionless scheduler is what stops the operator
    /// censoring a user's bot by declining to run it.
    ///
    /// Both inputs the caller could once have lied about are now read on chain:
    /// the price from Pyth, and the vault's value from its own token accounts.
    pub fn evaluate_strategy(
        ctx: Context<EvaluateStrategy>,
        computation_offset: u64,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        require!(
            ctx.accounts.vault_config.status == VaultStatus::Active,
            VaultError::VaultNotActive
        );

        let strategy = &ctx.accounts.strategy_state;
        require!(strategy.mxe_version > 0, VaultError::StrategyNotConverted);

        let price = read_sol_usd_price(&ctx.accounts.price_update)?;

        // Read from the vault's own accounts rather than trusting arguments.
        // Both balances, because a buy spends quote and a sell spends base —
        // the circuit must size each against the balance it will actually debit.
        let quote_value = ctx.accounts.vault_quote_ata.amount;
        let base_value = ctx.accounts.vault_base_ata.amount;

        let args = ArgBuilder::new()
            .plaintext_u128(strategy.mxe_nonce)
            .encrypted_u64(strategy.mxe_ciphertexts[0])
            .encrypted_u64(strategy.mxe_ciphertexts[1])
            .encrypted_u64(strategy.mxe_ciphertexts[2])
            .plaintext_u64(price.price)
            .plaintext_u64(quote_value)
            .plaintext_u64(base_value)
            // Public, and correctly so — see RiskLimits::size_bps.
            .plaintext_u64(ctx.accounts.vault_config.limits.size_bps as u64)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![EvaluateStrategyV3Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                // Every account the callback struct declares must appear here
                // too. Miss one and the callback fails at account resolution
                // with "AnchorError caused by account: <name>" — after the
                // computation has already run and been paid for.
                &[
                    CallbackAccount {
                        pubkey: ctx.accounts.trade_intent.key(),
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.vault_config.key(),
                        is_writable: false,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.strategy_state.key(),
                        is_writable: false,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    /// Turn a verified decision into a bounded trade authorization.
    ///
    /// This is the only writer of `TradeIntent`, and the only thing that can
    /// authorize vault funds into a swap. It authorizes a side and a size inside
    /// a slot window — never a destination, never a program, never a withdrawal.
    #[arcium_callback(encrypted_ix = "evaluate_strategy_v3")]
    pub fn evaluate_strategy_v3_callback(
        ctx: Context<EvaluateStrategyV3Callback>,
        output: SignedComputationOutputs<EvaluateStrategyV3Output>,
    ) -> Result<()> {
        require!(
            ctx.accounts.cluster_account.key() == expected_cluster(),
            VaultError::UnexpectedCluster
        );

        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(v) => v,
            Err(_) => return Err(VaultError::AbortedComputation.into()),
        };

        let action = o.field_0.field_0;
        let amount_in = o.field_0.field_1;

        // HOLD writes nothing. A missing intent and a decision not to trade are
        // the same state, which is the safe direction: no result means no trade.
        if action == 0 || amount_in == 0 {
            emit!(EvaluationHeld {
                vault: ctx.accounts.vault_config.key(),
            });
            return Ok(());
        }

        let vault = &ctx.accounts.vault_config;
        let intent = &mut ctx.accounts.trade_intent;
        let clock = Clock::get()?;

        intent.vault = vault.key();
        intent.side = action;
        intent.amount_in = amount_in;
        // Filled by the executor's quote at execution time, bounded by the
        // vault's slippage limit. Set to zero here so an executor cannot claim
        // the callback authorized a worse floor than it did.
        intent.min_amount_out = 0;
        intent.expires_at_slot = clock.slot.saturating_add(INTENT_TTL_SLOTS);
        intent.vault_nonce = vault.nonce;
        intent.strategy_version = ctx.accounts.strategy_state.mxe_version;
        intent.oracle_price = 0;
        intent.consumed = false;

        emit!(TradeAuthorized {
            vault: intent.vault,
            side: intent.side,
            amount_in: intent.amount_in,
            expires_at_slot: intent.expires_at_slot,
        });
        Ok(())
    }

    /// Circuit breaker. Owner only.
    ///
    /// There was a `GUARDIAN` branch here. It resolved to this program's own id,
    /// which is the public key of the deploy keypair — so it granted the
    /// deployer the power to pause any user's vault. See constants.rs for why it
    /// is gone rather than repointed. Pausing stops new trades and never blocks
    /// `withdraw`.
    pub fn pause(ctx: Context<SetStatus>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let vault_config = &mut ctx.accounts.vault_config;

        require!(
            authority == vault_config.owner,
            VaultError::NotPauseAuthority
        );
        require!(
            vault_config.status != VaultStatus::Stopped,
            VaultError::VaultStopped
        );

        vault_config.status = VaultStatus::Paused;
        emit!(StatusChanged {
            vault: vault_config.key(),
            status: VaultStatus::Paused,
            authority,
        });
        Ok(())
    }

    /// Return a paused vault to service. Owner only.
    pub fn resume(ctx: Context<SetStatus>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let vault_config = &mut ctx.accounts.vault_config;

        require!(authority == vault_config.owner, VaultError::NotPauseAuthority);
        require!(
            vault_config.status != VaultStatus::Stopped,
            VaultError::VaultStopped
        );

        vault_config.status = VaultStatus::Active;
        emit!(StatusChanged {
            vault: vault_config.key(),
            status: VaultStatus::Active,
            authority,
        });
        Ok(())
    }

    /// Terminal wind-down. Owner only, irreversible. Withdrawals still work.
    pub fn stop(ctx: Context<SetStatus>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let vault_config = &mut ctx.accounts.vault_config;

        require!(authority == vault_config.owner, VaultError::NotPauseAuthority);

        vault_config.status = VaultStatus::Stopped;
        emit!(StatusChanged {
            vault: vault_config.key(),
            status: VaultStatus::Stopped,
            authority,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(constraint = base_mint.key() == BASE_MINT @ VaultError::MintNotAllowed)]
    pub base_mint: Account<'info, Mint>,

    #[account(constraint = quote_mint.key() == QUOTE_MINT @ VaultError::MintNotAllowed)]
    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = base_mint,
        associated_token::authority = vault_config,
    )]
    pub vault_base_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = quote_mint,
        associated_token::authority = vault_config,
    )]
    pub vault_quote_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CopyStrategy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The follower's vault. Seeded by the signer, so this can only ever write
    /// into a vault the caller owns.
    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner,
    )]
    pub vault_config: Box<Account<'info, VaultConfig>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + StrategyState::INIT_SPACE,
        seeds = [STRATEGY_SEED, vault_config.key().as_ref()],
        bump,
    )]
    pub strategy_state: Box<Account<'info, StrategyState>>,

    /// The vault being followed. Read only — nothing here can modify it.
    pub leader_vault: Box<Account<'info, VaultConfig>>,

    /// The leader's strategy, tied to the leader's vault by its seeds so a
    /// caller cannot pair one vault's listing with another vault's strategy.
    #[account(
        seeds = [STRATEGY_SEED, leader_vault.key().as_ref()],
        bump = leader_strategy.bump,
    )]
    pub leader_strategy: Box<Account<'info, StrategyState>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetListing<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner,
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct UpdateLimits<'info> {
    pub owner: Signer<'info>,

    /// Seeded by `owner` and `has_one` checked, so a signer can only ever reach
    /// their own vault's limits.
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner,
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,

    /// Seeded by `owner`, so a signer can only ever reach their own vault.
    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        constraint = mint.key() == vault_config.base_mint
            || mint.key() == vault_config.quote_mint @ VaultError::MintNotAllowed
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_config,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        constraint = mint.key() == vault_config.base_mint
            || mint.key() == vault_config.quote_mint @ VaultError::MintNotAllowed
    )]
    pub mint: Account<'info, Mint>,

    /// Destination is derived from `owner`, never supplied as a parameter.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_config,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// The cluster account this vault accepts results from.
///
/// Derived from a compiled-in offset rather than from the MXE account, which is
/// the entire point: the MXE's binding can be migrated by its authority, this
/// cannot be changed without a program upgrade. See ARCHITECTURE.md §7.1.
pub fn expected_cluster() -> Pubkey {
    Pubkey::find_program_address(
        &[CLUSTER_PDA_SEED, &EXPECTED_CLUSTER_OFFSET.to_le_bytes()],
        &ARCIUM_PROG_ID,
    )
    .0
}

#[derive(Accounts)]
pub struct InitTradeIntent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    /// Created ahead of time because an Arcium callback cannot create accounts —
    /// it can only write to ones declared writable when the computation was queued.
    #[account(
        init,
        payer = owner,
        space = 8 + TradeIntent::INIT_SPACE,
        seeds = [INTENT_SEED, vault_config.key().as_ref()],
        bump,
    )]
    pub trade_intent: Account<'info, TradeIntent>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("store_strategy_v2", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ConvertStrategy<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, payer.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Box<Account<'info, VaultConfig>>,
    #[account(
        mut,
        seeds = [STRATEGY_SEED, vault_config.key().as_ref()],
        bump = strategy_state.bump,
    )]
    pub strategy_state: Box<Account<'info, StrategyState>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_STORE_STRATEGY))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("store_strategy_v2")]
#[derive(Accounts)]
pub struct StoreStrategyV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_STORE_STRATEGY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub strategy_state: Box<Account<'info, StrategyState>>,
}

#[queue_computation_accounts("evaluate_strategy_v3", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct EvaluateStrategy<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Not seeded by `payer`: anyone may evaluate. Nothing is revealed and
    /// nothing is authorized by evaluating, and permissionless scheduling is
    /// what stops the operator censoring a user's bot.
    #[account(
        seeds = [VAULT_SEED, vault_config.owner.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Box<Account<'info, VaultConfig>>,
    #[account(
        seeds = [STRATEGY_SEED, vault_config.key().as_ref()],
        bump = strategy_state.bump,
    )]
    pub strategy_state: Box<Account<'info, StrategyState>>,
    #[account(
        mut,
        seeds = [INTENT_SEED, vault_config.key().as_ref()],
        bump = trade_intent.bump,
    )]
    pub trade_intent: Box<Account<'info, TradeIntent>>,
    /// The vault's own quote balance. Read here rather than passed in, so a
    /// caller cannot inflate the size of someone else's trade.
    #[account(
        associated_token::mint = vault_config.quote_mint,
        associated_token::authority = vault_config,
    )]
    pub vault_quote_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        associated_token::mint = vault_config.base_mint,
        associated_token::authority = vault_config,
    )]
    pub vault_base_ata: Box<Account<'info, TokenAccount>>,
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_EVALUATE_STRATEGY))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("evaluate_strategy_v3")]
#[derive(Accounts)]
pub struct EvaluateStrategyV3Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_EVALUATE_STRATEGY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Boxed: Anchor account structs live on the stack, and Solana's frame is
    // 4 KB. StrategyState alone is ~360 bytes and these three together overflow
    // it, which shows up as an access violation inside the callback rather than
    // as anything resembling a size error.
    #[account(mut)]
    pub trade_intent: Box<Account<'info, TradeIntent>>,
    pub vault_config: Box<Account<'info, VaultConfig>>,
    #[account(
        seeds = [STRATEGY_SEED, vault_config.key().as_ref()],
        bump = strategy_state.bump,
    )]
    pub strategy_state: Box<Account<'info, StrategyState>>,
}

#[init_computation_definition_accounts("store_strategy_v2", payer)]
#[derive(Accounts)]
pub struct InitStoreStrategyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("evaluate_strategy_v3", payer)]
#[derive(Accounts)]
pub struct InitEvaluateStrategyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteTrade<'info> {
    /// Permissionless. Holds no privilege; pays the fee and picks the moment.
    pub executor: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.owner.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Box<Account<'info, VaultConfig>>,
    #[account(
        mut,
        seeds = [INTENT_SEED, vault_config.key().as_ref()],
        bump = trade_intent.bump,
        constraint = trade_intent.vault == vault_config.key() @ VaultError::NoTradeAuthorized,
    )]
    pub trade_intent: Box<Account<'info, TradeIntent>>,
    #[account(
        seeds = [STRATEGY_SEED, vault_config.key().as_ref()],
        bump = strategy_state.bump,
    )]
    pub strategy_state: Box<Account<'info, StrategyState>>,
    /// Both vault ATAs, because either can be the source depending on side.
    /// Derived from `vault_config`, never passed loose — a destination the
    /// caller can choose is a rug waiting for a bug.
    #[account(
        mut,
        associated_token::mint = vault_config.quote_mint,
        associated_token::authority = vault_config,
    )]
    pub vault_quote_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = vault_config.base_mint,
        associated_token::authority = vault_config,
    )]
    pub vault_base_ata: Box<Account<'info, TokenAccount>>,
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    /// Pinned. The only program this instruction will CPI into.
    #[account(address = JUPITER_PROGRAM_ID @ VaultError::SwapProgramNotAllowed)]
    /// CHECK: address-constrained to the pinned aggregator; invoked, not read.
    pub jupiter_program: UncheckedAccount<'info>,
}

#[event]
pub struct TradeExecuted {
    pub vault: Pubkey,
    pub side: u8,
    pub amount_in: u64,
    /// What the swap actually delivered into the vault.
    pub amount_out: u64,
    /// The oracle-derived floor it had to clear.
    pub min_amount_out: u64,
    pub oracle_price: u64,
}

#[event]
pub struct StrategyConverted {
    pub vault: Pubkey,
    pub version: u32,
}

#[event]
pub struct EvaluationHeld {
    pub vault: Pubkey,
}

#[event]
pub struct TradeAuthorized {
    pub vault: Pubkey,
    pub side: u8,
    pub amount_in: u64,
    pub expires_at_slot: u64,
}

#[derive(Accounts)]
pub struct SubmitStrategy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + StrategyState::INIT_SPACE,
        seeds = [STRATEGY_SEED, vault_config.key().as_ref()],
        bump,
    )]
    pub strategy_state: Account<'info, StrategyState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetStatus<'info> {
    pub authority: Signer<'info>,

    /// Seeded by `vault_config.owner` rather than by `authority`, a shape left
    /// over from the removed guardian. Every handler now checks
    /// `authority == vault_config.owner` explicitly, so this is equivalent to
    /// seeding by the signer — but the explicit check is what enforces it.
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.owner.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct StrategySubmitted {
    pub vault: Pubkey,
    pub version: u32,
}

#[event]
pub struct StatusChanged {
    pub vault: Pubkey,
    pub status: VaultStatus,
    pub authority: Pubkey,
}

#[event]
pub struct StrategyCopied {
    pub vault: Pubkey,
    pub leader: Pubkey,
    pub version: u32,
}

#[event]
pub struct ListingChanged {
    pub vault: Pubkey,
    pub listed: bool,
}

#[event]
pub struct LimitsUpdated {
    pub vault: Pubkey,
    /// The bumped nonce, which is also the receipt that any in-flight
    /// authorization was invalidated.
    pub nonce: u64,
}
