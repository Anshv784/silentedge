//! Pyth SOL/USD price, validated before it can influence a decision.
//!
//! The point of this module is that the price is **read on chain**, not passed
//! in. Until now `evaluate_strategy` took a `price: u64` argument, which meant
//! anyone queueing an evaluation could name any price and drive the strategy
//! wherever they wanted. That is fine for exercising a circuit and unacceptable
//! for money.
//!
//! Pyth is a pull oracle: someone posts a signed price update account, and
//! consumers read it. The receiver program verifies the Wormhole attestation, so
//! by the time a `PriceUpdateV2` account exists its contents are authentic. What
//! remains for us is deciding whether an authentic price is *usable*.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

// Anchor permits exactly one #[error_code] enum per program, so the oracle's
// failures live in the program-wide enum rather than their own.
use crate::HelloError as OracleError;

/// SOL/USD. Same feed id on every cluster — it identifies the feed, not the
/// deployment, and `get_price_no_older_than` rejects an account for any other.
pub const SOL_USD_FEED_ID: &str =
    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/// Reject anything older than this.
///
/// Pyth's own guidance is blunt about the risk here: an adversary racing a price
/// update has a head start, so never build a flow that depends on winning that
/// race. Thirty seconds is tight enough that a stale price cannot drift far, and
/// loose enough to survive ordinary network jitter.
pub const MAX_PRICE_AGE_SECONDS: u64 = 30;

/// Reject when the confidence interval is wide relative to the price.
///
/// Pyth widens confidence when publishers disagree or liquidity thins — exactly
/// the conditions where a single number is least trustworthy. Their docs suggest
/// widening spreads; refusing to trade is simpler and strictly safer.
pub const MAX_CONF_BPS: u128 = 100; // 1%

/// Fixed-point scale for prices everywhere in this system.
pub const PRICE_DECIMALS: i32 = 6;

/// Sanity band. Not a market view — a tripwire for a feed that has gone wrong
/// in a way confidence and staleness would not catch.
pub const MIN_REASONABLE_PRICE: u64 = 1_000_000; // $1
pub const MAX_REASONABLE_PRICE: u64 = 10_000_000_000; // $10,000

/// Read, validate, and normalise the SOL/USD price to 6 decimals.
///
/// Every failure here is a refusal to trade, never a fallback to a default. A
/// bot that trades on a bad price is worse than a bot that does not trade.
pub fn read_sol_usd_price(price_update: &Account<PriceUpdateV2>) -> Result<u64> {
    let feed_id = get_feed_id_from_hex(SOL_USD_FEED_ID)?;

    // Fails on a stale update and on a wrong feed. Both are refusals, and both
    // are enforced by the SDK rather than reimplemented here.
    let price = price_update.get_price_no_older_than(
        &Clock::get()?,
        MAX_PRICE_AGE_SECONDS,
        &feed_id,
    )?;

    require!(price.price > 0, OracleError::NonPositivePrice);
    let raw = price.price as u128;

    // Confidence relative to price, in basis points. Checked before scaling so
    // the ratio is unaffected by exponent handling.
    let conf_bps = (price.conf as u128)
        .checked_mul(10_000)
        .ok_or(OracleError::ScalingOverflow)?
        .checked_div(raw)
        .ok_or(OracleError::ScalingOverflow)?;
    require!(conf_bps <= MAX_CONF_BPS, OracleError::ConfidenceTooWide);

    let scaled = scale_to_price_decimals(raw, price.exponent)?;

    require!(
        (MIN_REASONABLE_PRICE..=MAX_REASONABLE_PRICE).contains(&scaled),
        OracleError::PriceOutOfBand
    );

    Ok(scaled)
}

/// Convert a Pyth `(value, exponent)` pair into our fixed-point scale.
///
/// Pyth reports `value * 10^exponent`; we want that same number expressed with
/// `PRICE_DECIMALS` digits. SOL/USD publishes at `exponent = -8`, so the usual
/// path divides by 100 — but the exponent is a property of the feed and can
/// change, so this handles both directions rather than assuming.
///
/// Truncation on the divide is deliberate and harmless: it loses at most one
/// unit in the sixth decimal, well inside the confidence interval we already
/// require to be under 1%.
pub fn scale_to_price_decimals(value: u128, exponent: i32) -> Result<u64> {
    let shift = exponent
        .checked_add(PRICE_DECIMALS)
        .ok_or(OracleError::ExponentOutOfRange)?;

    // 10^38 overflows u128; anything near that is a broken feed, not a price.
    require!((-38..=38).contains(&shift), OracleError::ExponentOutOfRange);

    let scaled = if shift >= 0 {
        let factor = 10u128
            .checked_pow(shift as u32)
            .ok_or(OracleError::ScalingOverflow)?;
        value
            .checked_mul(factor)
            .ok_or(OracleError::ScalingOverflow)?
    } else {
        let divisor = 10u128
            .checked_pow((-shift) as u32)
            .ok_or(OracleError::ScalingOverflow)?;
        value / divisor
    };

    u64::try_from(scaled).map_err(|_| OracleError::ScalingOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_pyth_sol_usd() {
        // A real observation: 7554404325 at exponent -8 is $75.54404325.
        assert_eq!(scale_to_price_decimals(7_554_404_325, -8).unwrap(), 75_544_043);
    }

    #[test]
    fn handles_both_exponent_directions() {
        // Already at 6 decimals.
        assert_eq!(scale_to_price_decimals(150_000_000, -6).unwrap(), 150_000_000);
        // Coarser than 6 decimals: scale up. 15_000 at exponent -2 is $150.
        assert_eq!(scale_to_price_decimals(15_000, -2).unwrap(), 150_000_000);
        // Finer: scale down.
        assert_eq!(scale_to_price_decimals(150_000_000_000, -9).unwrap(), 150_000_000);
    }

    #[test]
    fn rejects_absurd_exponents() {
        assert!(scale_to_price_decimals(1, 100).is_err());
        assert!(scale_to_price_decimals(1, -100).is_err());
    }

    #[test]
    fn rejects_values_that_do_not_fit_u64() {
        assert!(scale_to_price_decimals(u128::MAX, -6).is_err());
    }
}
