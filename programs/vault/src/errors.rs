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

    #[msg("No strategy has been stored for this vault")]
    NoStrategyStored,

    #[msg("Strategy has not been converted to MXE-encrypted state yet")]
    StrategyNotConverted,

    #[msg("The computation was aborted or could not be verified")]
    AbortedComputation,

    #[msg("Result came from a cluster this vault does not accept")]
    UnexpectedCluster,

    #[msg("No trade is currently authorized")]
    NoTradeAuthorized,

    #[msg("This trade authorization has already been used")]
    IntentAlreadyConsumed,

    #[msg("This trade authorization has expired")]
    IntentExpired,

    #[msg("Trade authorization does not match the vault's current nonce")]
    IntentStale,

    #[msg("Trade authorization was issued for a different strategy version")]
    IntentStrategyMismatch,

    #[msg("Trade exceeds the vault's maximum trade size")]
    TradeTooLarge,

    #[msg("Cooldown between trades has not elapsed")]
    CooldownActive,

    #[msg("Execution price deviates too far from the oracle")]
    OracleDeviationTooLarge,

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

    // --- swap execution ---
    #[msg("Vault does not hold enough of the input mint for this trade")]
    InsufficientSourceBalance,

    #[msg("Swap moved an unexpected amount out of the vault")]
    UnexpectedSourceDelta,

    #[msg("Swap returned less than the oracle-derived minimum")]
    SlippageExceeded,

    #[msg("Swap changed the vault account's lamports")]
    VaultLamportsChanged,

    #[msg("Trade intent carries an unknown side")]
    UnknownSide,

    #[msg("Swap program is not the pinned aggregator")]
    SwapProgramNotAllowed,

    // --- following ---
    #[msg("That vault is not listed for public discovery")]
    VaultNotListed,

    #[msg("A vault cannot follow itself")]
    CannotFollowSelf,
}
