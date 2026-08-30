//! The smallest real Arcium computation, wired end to end.
//!
//! This program exists to prove three things before any of the machinery is
//! pointed at money:
//!
//!   1. a computation genuinely executes on an Arcium cluster, not locally;
//!   2. the encrypted input is never revealed to the program or the chain;
//!   3. the result comes back through a callback the program can verify.
//!
//! It is deliberately a separate program from the vault. Every instruction in a
//! custody program is attack surface, and a demonstration has no business
//! living there.
//!
//! The three-function shape here — init the computation definition, queue a
//! computation, handle the callback — is the same shape the strategy evaluation
//! will take.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
// Not re-exported by the prelude in 0.14.1.
use arcium_client::idl::arcium::types::CallbackAccount;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

pub mod oracle;
pub use oracle::*;

const COMP_DEF_OFFSET_ADD_TEN: u32 = comp_def_offset("add_ten");
const COMP_DEF_OFFSET_STORE_STRATEGY: u32 = comp_def_offset("store_strategy");
const COMP_DEF_OFFSET_EXPORT_STRATEGY: u32 = comp_def_offset("export_strategy");
const COMP_DEF_OFFSET_EVALUATE_STRATEGY: u32 = comp_def_offset("evaluate_strategy");

/// Four encrypted scalars: entry_below, exit_above, stop_below, size_bps.
/// Three, not four.
///
/// This was 4 from when `size_bps` was encrypted alongside the thresholds. The
/// live circuit's `Strategy` (encrypted-ixs/src/lib.rs) carries exactly three
/// fields — entry, exit, stop — because the trade size is deliberately public
/// (SECURITY.md T-38: one trade recovers it exactly, so encrypting it bought
/// nothing and cost a field). The stale 4 made this program fail to compile,
/// and because it is a workspace member that broke `arcium build` for the
/// whole repo, not just for itself.
pub const STRATEGY_FIELDS: usize = 3;
pub const STORED_STRATEGY_SEED: &[u8] = b"stored_strategy";

declare_id!("FPZkMe1NgT3oug3iLoaWsnPjGAEr3p7mwporhfVqU7Lk");

#[arcium_program]
pub mod hello_arcium {
    use super::*;

    /// Register the circuit on chain. Once per computation definition, ever.
    pub fn init_add_ten_comp_def(ctx: Context<InitAddTenCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Queue `x + 10` for the cluster.
    ///
    /// `x` arrives as a 32-byte ciphertext. The program passes it through
    /// without ever being able to read it — it has neither half of the key
    /// exchange that produced it.
    ///
    /// Argument order must match the circuit signature exactly: for
    /// `Enc<Shared, T>` that is public key, then nonce, then ciphertexts. Get
    /// this wrong and the computation fails silently rather than loudly.
    pub fn add_ten(
        ctx: Context<AddTen>,
        computation_offset: u64,
        ciphertext_x: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ciphertext_x)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![AddTenCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    /// Handle the cluster's result.
    ///
    /// `verify_output` checks the cluster's BLS threshold signature over the
    /// output. This is the trust boundary: the transaction carrying the callback
    /// is signed by an ordinary node keypair and proves nothing on its own, so
    /// the program trusts this check and never the transaction's signer.
    ///
    /// The same verification is what will authorize trades later, which is why
    /// it is worth exercising here first.
    #[arcium_callback(encrypted_ix = "add_ten")]
    pub fn add_ten_callback(
        ctx: Context<AddTenCallback>,
        output: SignedComputationOutputs<AddTenOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(AddTenOutput { field_0 }) => field_0,
            Err(_) => return Err(HelloError::AbortedComputation.into()),
        };

        // Still ciphertext. The program emits it without knowing the answer;
        // only the client holding the other half of the key exchange can read it.
        emit!(SumEvent {
            sum: o.ciphertexts[0],
            nonce: o.nonce.to_le_bytes(),
        });
        Ok(())
    }

    // ---------------------------------------------------------------
    // Persistent confidential strategy state
    // ---------------------------------------------------------------

    pub fn init_store_strategy_comp_def(ctx: Context<InitStoreStrategyCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn init_export_strategy_comp_def(ctx: Context<InitExportStrategyCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Create the account that will hold a user's MXE-encrypted strategy.
    ///
    /// Separate from `store_strategy` because accounts cannot be created inside
    /// an Arcium callback — the callback can only write to accounts that
    /// already exist and were declared writable when the computation was queued.
    pub fn init_stored_strategy(ctx: Context<InitStoredStrategy>) -> Result<()> {
        let stored = &mut ctx.accounts.stored_strategy;
        stored.owner = ctx.accounts.owner.key();
        stored.version = 0;
        stored.bump = ctx.bumps.stored_strategy;
        Ok(())
    }

    /// Re-encrypt a user's strategy from `Enc<Shared, _>` to `Enc<Mxe, _>`.
    ///
    /// Argument order follows the circuit signature: for `Enc<Shared, T>` that
    /// is the x25519 public key, then the nonce, then one ciphertext per field.
    pub fn store_strategy(
        ctx: Context<StoreStrategy>,
        computation_offset: u64,
        ciphertexts: [[u8; 32]; STRATEGY_FIELDS],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ciphertexts[0])
            .encrypted_u64(ciphertexts[1])
            .encrypted_u64(ciphertexts[2])
            .encrypted_u64(ciphertexts[3])
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![StoreStrategyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                // The callback writes the MXE ciphertext here, so it has to be
                // declared writable at queue time as well as in the callback
                // account struct. Marking only one of the two fails silently.
                &[CallbackAccount {
                    pubkey: ctx.accounts.stored_strategy.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "store_strategy")]
    pub fn store_strategy_callback(
        ctx: Context<StoreStrategyCallback>,
        output: SignedComputationOutputs<StoreStrategyOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(StoreStrategyOutput { field_0 }) => field_0,
            Err(_) => return Err(HelloError::AbortedComputation.into()),
        };

        // MXE-encrypted: there is no shared key here, and no client can decrypt
        // this. The program stores opaque bytes it could not read if it wanted to.
        let stored = &mut ctx.accounts.stored_strategy;
        stored.ciphertexts = o.ciphertexts;
        stored.nonce = o.nonce;
        stored.version = stored.version.checked_add(1).ok_or(HelloError::Overflow)?;

        emit!(StrategyStored {
            owner: stored.owner,
            version: stored.version,
        });
        Ok(())
    }

    /// Read persisted state back, re-encrypted to the caller.
    ///
    /// The circuit cannot tell who asked, so the account constraints do it:
    /// `stored_strategy` is seeded by `owner`, and `owner` must sign. Without
    /// that, anyone could queue this with their own key and read the strategy.
    pub fn export_strategy(
        ctx: Context<ExportStrategy>,
        computation_offset: u64,
        reader_pubkey: [u8; 32],
        reader_nonce: u128,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let stored = &ctx.accounts.stored_strategy;
        require!(stored.version > 0, HelloError::NoStrategyStored);

        // Enc<Mxe, T> takes only nonce + ciphertexts — no x25519 key, because
        // there is no shared secret. The trailing `reader: Shared` parameter is
        // what needs the key.
        let args = ArgBuilder::new()
            .plaintext_u128(stored.nonce)
            .encrypted_u64(stored.ciphertexts[0])
            .encrypted_u64(stored.ciphertexts[1])
            .encrypted_u64(stored.ciphertexts[2])
            .encrypted_u64(stored.ciphertexts[3])
            .x25519_pubkey(reader_pubkey)
            .plaintext_u128(reader_nonce)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ExportStrategyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    pub fn init_evaluate_strategy_comp_def(
        ctx: Context<InitEvaluateStrategyCompDef>,
    ) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Evaluate the stored strategy against a public price.
    ///
    /// `price` and `vault_value` are plaintext on purpose. The price is public
    /// information and the vault balance is a public token account; encrypting
    /// them would cost gates and hide nothing.
    ///
    /// The price is read from Pyth here rather than accepted as an argument.
    /// `vault_value` is still passed in, which is a remaining hole: it scales
    /// the trade size, so a caller can inflate it. It closes when the vault owns
    /// this instruction and can read its own token accounts (Phase 11).
    ///
    /// Anyone may queue this — evaluation is not a privileged action, and a
    /// permissionless scheduler is what stops the operator being able to censor
    /// a user's bot by simply not running it. The result authorizes nothing on
    /// its own; that is the trading phase's job.
    pub fn evaluate_strategy(
        ctx: Context<EvaluateStrategy>,
        computation_offset: u64,
        vault_value: u64,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let stored = &ctx.accounts.stored_strategy;
        require!(stored.version > 0, HelloError::NoStrategyStored);

        // Read on chain rather than accepting a caller-supplied number. This
        // instruction is permissionless, so a price argument would let anyone
        // drive someone else's strategy to whatever decision they wanted.
        // Every validation inside is a refusal, never a fallback.
        let price = read_sol_usd_price(&ctx.accounts.price_update)?;

        // Enc<Mxe, T> needs no x25519 key — there is no shared secret. Order
        // must match the circuit signature: the encrypted struct, then the two
        // plaintext scalars.
        let args = ArgBuilder::new()
            .plaintext_u128(stored.nonce)
            .encrypted_u64(stored.ciphertexts[0])
            .encrypted_u64(stored.ciphertexts[1])
            .encrypted_u64(stored.ciphertexts[2])
            .encrypted_u64(stored.ciphertexts[3])
            .plaintext_u64(price)
            .plaintext_u64(vault_value)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![EvaluateStrategyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    /// Receive the decision.
    ///
    /// The revealed pair is the minimum a trade needs: a side and a size.
    /// Nothing about *why* it fired comes back — which threshold was crossed,
    /// how far past it the price is, or what the other thresholds are.
    #[arcium_callback(encrypted_ix = "evaluate_strategy")]
    pub fn evaluate_strategy_callback(
        ctx: Context<EvaluateStrategyCallback>,
        output: SignedComputationOutputs<EvaluateStrategyOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(v) => v,
            Err(_) => return Err(HelloError::AbortedComputation.into()),
        };

        // A tuple return nests one level deeper than a single return:
        // field_0 is the tuple struct, not the first element.
        emit!(StrategyEvaluated {
            action: o.field_0.field_0,
            amount: o.field_0.field_1,
        });
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "export_strategy")]
    pub fn export_strategy_callback(
        ctx: Context<ExportStrategyCallback>,
        output: SignedComputationOutputs<ExportStrategyOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ExportStrategyOutput { field_0 }) => field_0,
            Err(_) => return Err(HelloError::AbortedComputation.into()),
        };

        emit!(StrategyRead {
            ciphertexts: o.ciphertexts,
            nonce: o.nonce.to_le_bytes(),
        });
        Ok(())
    }
}

#[queue_computation_accounts("add_ten", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct AddTen<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_TEN))]
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

#[callback_accounts("add_ten")]
#[derive(Accounts)]
pub struct AddTenCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_TEN))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[init_computation_definition_accounts("add_ten", payer)]
#[derive(Accounts)]
pub struct InitAddTenCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program. Not initialized yet.
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

/// A user's strategy, encrypted to the MXE cluster.
///
/// The program writes and reads these bytes and cannot interpret them. Only the
/// cluster acting together can decrypt `Enc<Mxe, _>` — not the program, not the
/// operator, and not the owner's browser.
#[account]
#[derive(InitSpace, Debug)]
pub struct StoredStrategy {
    pub owner: Pubkey,
    pub ciphertexts: [[u8; 32]; STRATEGY_FIELDS],
    pub nonce: u128,
    /// Incremented on every store. Zero means nothing has been stored yet.
    pub version: u32,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitStoredStrategy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + StoredStrategy::INIT_SPACE,
        seeds = [STORED_STRATEGY_SEED, owner.key().as_ref()],
        bump,
    )]
    pub stored_strategy: Account<'info, StoredStrategy>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("store_strategy", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct StoreStrategy<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Seeded by `payer`, so a signer can only ever write their own strategy.
    #[account(
        mut,
        seeds = [STORED_STRATEGY_SEED, payer.key().as_ref()],
        bump = stored_strategy.bump,
        has_one = owner @ HelloError::NotStrategyOwner,
    )]
    pub stored_strategy: Account<'info, StoredStrategy>,
    /// CHECK: bound to stored_strategy by the has_one constraint above.
    pub owner: UncheckedAccount<'info>,
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

#[callback_accounts("store_strategy")]
#[derive(Accounts)]
pub struct StoreStrategyCallback<'info> {
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
    /// Writable here AND in the CallbackAccount list passed at queue time.
    #[account(mut)]
    pub stored_strategy: Account<'info, StoredStrategy>,
}

#[queue_computation_accounts("export_strategy", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ExportStrategy<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Seeded by `payer`: the circuit cannot authenticate a reader, so this does.
    #[account(
        seeds = [STORED_STRATEGY_SEED, payer.key().as_ref()],
        bump = stored_strategy.bump,
    )]
    pub stored_strategy: Account<'info, StoredStrategy>,
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
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_EXPORT_STRATEGY))]
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

#[callback_accounts("export_strategy")]
#[derive(Accounts)]
pub struct ExportStrategyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_EXPORT_STRATEGY))]
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
}

#[queue_computation_accounts("evaluate_strategy", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct EvaluateStrategy<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Not seeded by `payer`: anyone may evaluate. The strategy stays secret
    /// either way, and permissionless evaluation is what stops the operator
    /// censoring a user's bot by declining to run it.
    #[account(
        seeds = [STORED_STRATEGY_SEED, stored_strategy.owner.as_ref()],
        bump = stored_strategy.bump,
    )]
    pub stored_strategy: Account<'info, StoredStrategy>,
    /// Pyth price update. Ownership by the receiver program is enforced by the
    /// account type; the feed id and staleness are checked when it is read.
    pub price_update: Account<'info, PriceUpdateV2>,
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

#[callback_accounts("evaluate_strategy")]
#[derive(Accounts)]
pub struct EvaluateStrategyCallback<'info> {
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
}

#[init_computation_definition_accounts("evaluate_strategy", payer)]
#[derive(Accounts)]
pub struct InitEvaluateStrategyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program. Not initialized yet.
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

#[init_computation_definition_accounts("store_strategy", payer)]
#[derive(Accounts)]
pub struct InitStoreStrategyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program. Not initialized yet.
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

#[init_computation_definition_accounts("export_strategy", payer)]
#[derive(Accounts)]
pub struct InitExportStrategyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program. Not initialized yet.
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

/// The only thing a trade needs: a side and a size.
///
/// 0 = HOLD, 1 = BUY, 2 = SELL. `amount` is in vault base units.
#[event]
pub struct StrategyEvaluated {
    pub action: u8,
    pub amount: u64,
}

#[event]
pub struct StrategyStored {
    pub owner: Pubkey,
    pub version: u32,
}

/// Ciphertext only. The program emits a strategy it cannot read.
#[event]
pub struct StrategyRead {
    pub ciphertexts: [[u8; 32]; STRATEGY_FIELDS],
    pub nonce: [u8; 16],
}

/// Carries ciphertext, not a sum. The program never learns the answer.
#[event]
pub struct SumEvent {
    pub sum: [u8; 32],
    pub nonce: [u8; 16],
}

#[error_code]
pub enum HelloError {
    #[msg("The computation was aborted")]
    AbortedComputation,

    #[msg("Signer does not own this strategy")]
    NotStrategyOwner,

    #[msg("No strategy has been stored yet")]
    NoStrategyStored,

    #[msg("Arithmetic overflow")]
    Overflow,

    // --- oracle ---
    #[msg("Oracle price is zero or negative")]
    NonPositivePrice,

    #[msg("Oracle confidence interval is too wide to trade on")]
    ConfidenceTooWide,

    #[msg("Oracle price is outside the reasonable band")]
    PriceOutOfBand,

    #[msg("Oracle exponent is outside the supported range")]
    ExponentOutOfRange,

    #[msg("Arithmetic overflow scaling the oracle price")]
    ScalingOverflow,
}
