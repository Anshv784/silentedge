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

pub mod constants;
pub mod errors;
pub mod state;

pub use constants::*;
pub use errors::VaultError;
pub use state::*;

declare_id!("J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ");

#[program]
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

        emit!(VaultInitialized {
            vault: vault_config.key(),
            owner: vault_config.owner,
            base_mint: vault_config.base_mint,
            quote_mint: vault_config.quote_mint,
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

    /// Circuit breaker. Callable by the owner or the guardian.
    ///
    /// The guardian exists so an anomaly can be stopped quickly. It is powerless
    /// beyond this: it cannot resume, cannot stop, and cannot withdraw.
    pub fn pause(ctx: Context<SetStatus>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let vault_config = &mut ctx.accounts.vault_config;

        require!(
            authority == vault_config.owner || authority == GUARDIAN,
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

    /// Return a paused vault to service. Owner only — the guardian may stop the
    /// bleeding but may not decide the owner is ready to trade again.
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

#[derive(Accounts)]
pub struct SetStatus<'info> {
    pub authority: Signer<'info>,

    /// Not seeded by `authority`: the guardian must be able to pause a vault it
    /// does not own. Authorization is checked explicitly in each handler.
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
pub struct StatusChanged {
    pub vault: Pubkey,
    pub status: VaultStatus,
    pub authority: Pubkey,
}
