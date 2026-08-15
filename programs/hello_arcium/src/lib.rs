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

const COMP_DEF_OFFSET_ADD_TEN: u32 = comp_def_offset("add_ten");

declare_id!("HVEKKMWwjLaQyXqkMGGshNGXa3Wm1PCSUnRaB6vAnB99");

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
}
