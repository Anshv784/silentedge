use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultStatus {
    /// Normal operation: deposits, withdrawals, and (later) trading.
    Active,
    /// Circuit breaker. Blocks deposits and trading. **Withdrawals still work.**
    Paused,
    /// Terminal wind-down. Blocks deposits and trading forever. Withdrawals still work.
    Stopped,
}

/// User-chosen risk parameters, fixed at vault creation.
///
/// Stored now but enforced by `execute_trade`, which arrives with the trading
/// phases. Keeping them here means a vault's risk envelope is chosen by its
/// owner at creation rather than supplied by whoever happens to submit a trade.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct RiskLimits {
    /// Max single trade as a fraction of vault value.
    pub max_trade_bps: u16,
    /// Max tolerated slippage on a swap.
    pub max_slippage_bps: u16,
    /// **STORED, NOT ENFORCED.** Nothing reads this field.
    ///
    /// It was documented as "max cumulative realised loss per UTC day", which
    /// this program cannot measure. Realised P&L needs a cost basis, and base
    /// tokens enter and leave outside trading — `deposit` and `withdraw` both
    /// accept either mint — so assigning basis means pricing a withdrawal,
    /// which means putting the oracle on the withdraw path. `withdraw` must
    /// keep working when Pyth, Arcium and the operator are all unavailable, so
    /// that trade is not available.
    ///
    /// Marking to market is measurable but is not loss: a NAV fall from SOL
    /// simply dropping is indistinguishable on chain from a fall caused by
    /// trading, and halting on it would disarm the vault precisely when a stop
    /// needs to fire.
    ///
    /// Left in place rather than deleted because removing it changes the
    /// account layout again. Do not describe it as protection.
    pub daily_loss_limit_bps: u16,
    /// Minimum seconds between trades.
    pub cooldown_seconds: u32,
    /// Reject oracle prices older than this.
    pub max_oracle_staleness_sec: u32,
    /// Reject oracle prices whose confidence/price ratio exceeds this.
    pub max_conf_bps: u16,
    /// Reject executions deviating from the oracle band by more than this.
    pub max_oracle_deviation_bps: u16,

    /// Share of the spendable balance a triggered rule trades, in basis points.
    ///
    /// Public on purpose. It used to be the fourth field of the *encrypted*
    /// strategy, which implied a secrecy it never had: the traded amount and
    /// the vault balance are both public in the same transaction, so
    /// `size_bps = amount * 10_000 / balance` recovers it exactly from a single
    /// trade. See SECURITY.md T-38 and docs/privacy.md. Encrypting it
    /// cost MPC gates to protect nothing, and told the user it was protected.
    pub size_bps: u16,
}

impl RiskLimits {
    /// Bounds-check user input. Every field is attacker-controlled at init, so
    /// each one is validated rather than trusted.
    pub fn validate(&self) -> Result<()> {
        require!(
            self.max_trade_bps > 0 && self.max_trade_bps <= MAX_TRADE_BPS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.max_slippage_bps > 0 && self.max_slippage_bps <= MAX_SLIPPAGE_BPS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.daily_loss_limit_bps > 0 && self.daily_loss_limit_bps <= BPS_DENOMINATOR,
            VaultError::InvalidRiskLimit
        );
        // This field had no bound at all, so a vault could be created with a
        // cooldown of ~136 years.
        require!(
            self.cooldown_seconds <= MAX_COOLDOWN_SECONDS,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.size_bps > 0 && self.size_bps <= MAX_SIZE_BPS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.max_oracle_staleness_sec > 0
                && self.max_oracle_staleness_sec <= MAX_ORACLE_STALENESS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.max_conf_bps > 0 && self.max_conf_bps <= MAX_CONF_BPS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.max_oracle_deviation_bps > 0
                && self.max_oracle_deviation_bps <= MAX_ORACLE_DEVIATION_CEILING,
            VaultError::InvalidRiskLimit
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace, Debug)]
pub struct VaultConfig {
    /// The only address funds can ever be withdrawn to.
    pub owner: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub limits: RiskLimits,
    pub status: VaultStatus,
    pub bump: u8,
    /// Monotonic. Bumped on every executed trade, so an old authorization can
    /// never be replayed against a vault that has moved on.
    pub nonce: u64,
    /// Unix time of the last executed trade, for `cooldown_seconds`.
    ///
    /// Zero until the first trade, which is what lets the first one through
    /// without a special case.
    pub last_trade_ts: i64,

    /// Whether this vault appears in public discovery.
    ///
    /// Carved from the reserve rather than appended, so every existing vault
    /// keeps the offset of every field it already had. An account created
    /// before this field existed reads it out of zeroed reserve bytes, which
    /// decodes as `false` — the correct default. That is the reserve working as
    /// intended, and the reason it was added.
    ///
    /// Listing publishes nothing that was not already public: the vault, its
    /// balances, its limits and its trades are all readable by anyone. It only
    /// makes the vault findable, and it never exposes the encrypted strategy —
    /// no instruction can.
    pub listed: bool,

    /// A display name for a listed vault. UTF-8, zero-padded, may be empty.
    ///
    /// Fixed width because Anchor accounts are fixed size. The program does not
    /// interpret it, and a client must treat it as untrusted text from a
    /// stranger — it is chosen by the vault's owner, not verified by anyone.
    pub name: [u8; 32],

    /// Ceiling on how much of the vault may sit in the base asset, in basis
    /// points of total value, enforced on entries only.
    ///
    /// Sits immediately before `reserved` because that is the rule. It was
    /// briefly inserted ahead of `listed`/`name` instead, which kept the struct
    /// the same total size — and shifted both of those fields four bytes, so
    /// every vault created in between would have read its listing flag out of
    /// the wrong place. Equal size is not the invariant; equal offsets are.
    ///
    /// The strategy decides *when* to buy; this decides how concentrated the
    /// vault is allowed to become. A rule like "buy below $150" keeps firing
    /// all the way down, so without a ceiling a falling market converts the
    /// whole vault into the falling asset — each individual trade inside its
    /// per-trade cap, and the position unbounded in aggregate. `max_trade_bps`
    /// cannot express this: it bounds one trade, not the sum of them.
    ///
    /// 0 means no ceiling, which is the value existing vaults read out of
    /// zeroed reserve bytes — preserving today's behaviour exactly.
    pub max_base_exposure_bps: u16,

    /// Refuse trades below this share of the spendable balance.
    ///
    /// A dust trade costs the same transaction and swap spread as a real one
    /// and moves nothing. With a small `size_bps` on a small vault, a strategy
    /// can otherwise grind the balance away in fees while appearing to work.
    /// 0 disables it, which is what existing vaults read.
    pub min_trade_bps: u16,

    /// Space for fields this struct does not have yet. Do not read or write it.
    ///
    /// Adding `last_trade_ts` made every already-created vault fail to load with
    /// `AccountDidNotDeserialize` (3003): the account was allocated at the old
    /// `INIT_SPACE` and borsh cannot fill the missing bytes. Survivable on
    /// devnet, where the stranded vaults held a test mint. Not survivable on
    /// mainnet, because `withdraw` takes `Account<'info, VaultConfig>` and would
    /// be stranded with everything else — the one path that must keep working.
    ///
    /// The rule, stated precisely, because the loose version is wrong:
    ///
    ///   a new field must be **appended immediately before this reserve** and
    ///   the reserve shrunk by the same number of bytes.
    ///
    /// Equal total size is necessary and *not* sufficient. `size_bps` was added
    /// to `RiskLimits`, which sits in the middle of this struct — same total
    /// size, but every field after it shifted two bytes, so existing vaults
    /// deserialized into garbage and failed with `ConstraintSeeds` (2006) on a
    /// mis-read `bump`. A quieter failure than the `AccountDidNotDeserialize`
    /// (3003) that a size change gives you, and the same outcome for funds.
    ///
    /// Borsh is positional. Preserving the byte count preserves nothing on its
    /// own; preserving the *offset of every existing field* is the requirement.
    pub reserved: [u8; 25],
}

impl VaultConfig {
    pub fn seeds(&self) -> [&[u8]; 3] {
        [VAULT_SEED, self.owner.as_ref(), std::slice::from_ref(&self.bump)]
    }
}

/// A vault's encrypted strategy.
///
/// The program stores these bytes and never interprets them. It cannot: the
/// plaintext is three integers encrypted under a secret shared between the
/// submitter and the MXE cluster, and nothing on chain holds either half of
/// that exchange. Storing opaque bytes is the point, not a limitation.
///
/// `encryption_pubkey` is the submitter's x25519 public key. The MXE needs it
/// to derive the same shared secret, so it is public by construction — it
/// reveals who encrypted, never what.
#[account]
#[derive(InitSpace, Debug)]
pub struct StrategyState {
    pub vault: Pubkey,
    /// One 32-byte ciphertext per encrypted scalar, in circuit field order.
    pub ciphertexts: [[u8; 32]; STRATEGY_FIELDS],
    /// Encryption nonce. Fresh per submission; reuse would leak.
    pub nonce: u128,
    pub encryption_pubkey: [u8; 32],
    /// Bumped on every submission of *plaintext* ciphertext by the owner.
    ///
    /// Note what binds an authorization: `mxe_version`, not this. Submitting a
    /// replacement now also zeroes `mxe_ciphertexts` and `mxe_version`, which
    /// is what actually stops the previous strategy trading — this comment used
    /// to claim that `version` did it, and nothing binds to `version`.
    pub version: u32,
    pub bump: u8,
    /// The vault this strategy was copied from, or the default pubkey if it is
    /// the owner's own. Carved from this struct's reserve, so existing strategy
    /// accounts keep every field offset they already had.
    ///
    /// Informational: nothing in the program branches on it. It exists so a
    /// follower can see, and prove, where their rules came from.
    pub follows: Pubkey,
    /// Same rule as `VaultConfig.reserved`: carve future fields out of this,
    /// never append. Added while this struct was being resized anyway (the
    /// ciphertext array went 4 -> 3), so it costs nothing now and stops the
    /// next change stranding every strategy account.
    pub reserved: [u8; 0],

    /// The same strategy re-encrypted to the MXE cluster.
    ///
    /// `ciphertexts` above is what the user submitted, readable by them. This is
    /// what the cluster produced from it, readable only by the cluster acting
    /// together — which is what lets evaluation run with nobody online.
    /// Zero `mxe_version` means the conversion has not happened yet.
    pub mxe_ciphertexts: [[u8; 32]; STRATEGY_FIELDS],
    pub mxe_nonce: u128,
    /// The `version` this converted copy is *for*.
    ///
    /// Set by `convert_strategy` when it queues the computation, before the
    /// ciphertext exists — so a non-zero value on its own does not mean the
    /// strategy can be evaluated. Use `is_armed()`, never this field alone.
    pub mxe_version: u32,
}

impl StrategyState {
    /// Is there a converted strategy that can actually be evaluated?
    ///
    /// Two conditions, and both are load-bearing. `mxe_version` is claimed at
    /// queue time so the callback can detect that the strategy was replaced
    /// underneath it; during that window the version is set and the ciphertext
    /// is still zero. Testing the version alone would let an evaluation run
    /// against 96 zero bytes — which is not a strategy, and whose decrypted
    /// thresholds are whatever that decodes to.
    pub fn is_armed(&self) -> bool {
        self.mxe_version > 0
            && self.mxe_ciphertexts.iter().any(|c| c.iter().any(|b| *b != 0))
    }
}

/// A single authorized trade, written only by a verified Arcium callback.
///
/// This is the whole authorization surface for moving vault funds into a swap.
/// It is deliberately a singleton per vault: a new decision overwrites any
/// unconsumed one, so there is no queue to stuff and no ordering to reason about.
///
/// Every field here is a constraint the executor must satisfy, not a hint. The
/// executor is permissionless precisely because it holds no privilege — it
/// chooses only whether and when to submit, inside a window this account defines.
#[account]
#[derive(InitSpace, Debug)]
pub struct TradeIntent {
    pub vault: Pubkey,
    /// 1 = BUY (quote -> base), 2 = SELL (base -> quote). 0 never lands here.
    pub side: u8,
    /// Input amount in the source mint's base units.
    pub amount_in: u64,
    /// Floor on the output, in the destination mint's base units, as computed
    /// when the intent was minted.
    ///
    /// Recorded, but deliberately *not* what the swap is checked against.
    /// `execute_trade` re-derives the floor from a fresh oracle read and
    /// enforces that instead, so a floor computed at decision time cannot go
    /// stale between the callback and execution. This field is the audit trail
    /// of what the decision expected; the enforced number is the fresh one.
    pub min_amount_out: u64,
    /// Slot after which this authorization is dead.
    pub expires_at_slot: u64,
    /// Must equal `VaultConfig.nonce`. Bumped on execution, which is what makes
    /// a consumed intent unreplayable even if `consumed` were somehow cleared.
    pub vault_nonce: u64,
    /// Binds the authorization to the strategy that produced it. Replacing the
    /// strategy invalidates any intent still in flight.
    pub strategy_version: u32,
    /// The oracle price the decision was made at.
    ///
    /// `execute_trade` compares this against a fresh read and refuses an entry
    /// that would fill more than `max_oracle_deviation_bps` above it. Exits are
    /// exempt by design — see the check itself for why blocking a stop because
    /// the price fell further would be backwards.
    pub oracle_price: u64,
    pub consumed: bool,
    pub bump: u8,
}
