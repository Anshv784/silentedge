use anchor_lang::prelude::*;

/// Seed prefix for the per-owner vault config PDA.
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed prefix for a vault's encrypted strategy.
pub const STRATEGY_SEED: &[u8] = b"strategy";

/// Encrypted scalars in a strategy: entry_below, exit_above, stop_below, size_bps.
/// Fixed because Arcis circuits are fixed-shape (RESEARCH.md §2.7).
pub const STRATEGY_FIELDS: usize = 4;

/// Wrapped SOL. Same address on every cluster.
pub const BASE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// USDC. Circle's canonical mint, per cluster.
#[cfg(not(feature = "mainnet"))]
pub const QUOTE_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
#[cfg(feature = "mainnet")]
pub const QUOTE_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// May pause a vault as a circuit breaker, and nothing else.
///
/// Deliberately powerless beyond pausing: it cannot withdraw, cannot resume
/// (only the owner can), and pausing never blocks the owner's withdrawal.
/// See THREAT_MODEL.md T-4.
#[cfg(not(feature = "mainnet"))]
pub const GUARDIAN: Pubkey = pubkey!("J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ");
#[cfg(feature = "mainnet")]
pub const GUARDIAN: Pubkey = pubkey!("J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ");

/// Basis-point denominator.
pub const BPS_DENOMINATOR: u16 = 10_000;

// Risk-limit bounds, enforced at vault creation. These cap how much rope a user
// can give their own bot; they are not a substitute for the per-trade checks
// that arrive with `execute_trade`.
pub const MAX_TRADE_BPS_CEILING: u16 = 5_000; // never more than 50% of the vault per trade
pub const MAX_SLIPPAGE_BPS_CEILING: u16 = 500; // 5%
pub const MAX_ORACLE_STALENESS_CEILING: u32 = 120; // seconds
pub const MAX_CONF_BPS_CEILING: u16 = 500; // reject prices with >5% confidence/price
pub const MAX_ORACLE_DEVIATION_CEILING: u16 = 1_000; // 10%
