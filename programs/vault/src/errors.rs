use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Mint is not on the allowlist")]
    MintNotAllowed,

    #[msg("Vault is not active")]
    VaultNotActive,

    #[msg("Vault is stopped")]
    VaultStopped,

    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Insufficient vault balance")]
    InsufficientBalance,

    #[msg("Risk limit is outside the permitted range")]
    InvalidRiskLimit,

    #[msg("Signer is not authorized to pause this vault")]
    NotPauseAuthority,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Encryption public key must not be all zeros")]
    InvalidEncryptionKey,
}
