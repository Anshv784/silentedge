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
use crate::constants::{BASE_DECIMALS_POW, BPS_DENOMINATOR, SIDE_BUY, SIDE_SELL};
use crate::VaultError as OracleError;

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

/// The minimum output a swap must deliver, derived on chain from the oracle.
///
/// A caller-supplied floor is the whole vulnerability. An executor that names
/// its own `min_amount_out` can route the vault's funds through a pool it
/// controls, fill at a ruinous price, and keep the difference — and the swap
/// still "succeeds". Deriving the floor from Pyth and the vault's own slippage
/// limit leaves the executor one choice only: whether to submit.
///
/// Assumes the quote mint's decimals equal `PRICE_DECIMALS` (both 6, USDC), so
/// they cancel. A quote mint with different decimals needs this revisited.
pub fn oracle_min_out(
    side: u8,
    amount_in: u64,
    price: u64,
    max_slippage_bps: u16,
) -> Result<u64> {
    require!(price > 0, OracleError::NonPositivePrice);
    require!(
        max_slippage_bps < BPS_DENOMINATOR,
        OracleError::SlippageExceeded
    );

    let a = amount_in as u128;
    let p = price as u128;

    // BUY spends quote (6dp) to get base (9dp): base = quote * 1e9 / price
    // SELL spends base (9dp) to get quote (6dp): quote = base * price / 1e9
    let expected = match side {
        SIDE_BUY => a
            .checked_mul(BASE_DECIMALS_POW)
            .and_then(|v| v.checked_div(p)),
        SIDE_SELL => a
            .checked_mul(p)
            .and_then(|v| v.checked_div(BASE_DECIMALS_POW)),
        _ => return err!(OracleError::UnknownSide),
    }
    .ok_or(OracleError::Overflow)?;

    let keep = (BPS_DENOMINATOR - max_slippage_bps) as u128;
    let min_out = expected
        .checked_mul(keep)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128))
        .ok_or(OracleError::Overflow)?;

    u64::try_from(min_out).map_err(|_| OracleError::Overflow.into())
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

    // --- oracle_min_out ---
    //
    // Checked against a live Jupiter quote: 500 USDC -> 6,647,760,174 lamports
    // at a SOL/USD of about $75.29 (RESEARCH §4.3). The floor must sit just
    // below a real fill, or every honest swap reverts.

    const P: u64 = 75_290_000; // $75.29
    const USDC_500: u64 = 500_000_000;

    #[test]
    fn buy_floor_tracks_a_real_quote() {
        let exact = oracle_min_out(SIDE_BUY, USDC_500, P, 0).unwrap();
        assert_eq!(exact, 6_640_988_179); // 500e6 * 1e9 / 75_290_000
        // A real fill of 6,647,760,174 must clear a 50 bps floor.
        let floor = oracle_min_out(SIDE_BUY, USDC_500, P, 50).unwrap();
        assert!(floor < 6_647_760_174, "floor {floor} would reject an honest fill");
        assert_eq!(floor, exact * 9_950 / 10_000);
    }

    #[test]
    fn sell_floor_is_the_inverse() {
        let out = oracle_min_out(SIDE_SELL, 6_647_760_174, P, 0).unwrap();
        // Round-trips to ~500 USDC. Not exact: the lamport figure is a real
        // Jupiter fill, which beat the oracle-implied amount, so the inverse
        // comes back slightly above 500. Within 1 USDC is the check that matters.
        assert!((out as i64 - USDC_500 as i64).abs() < 1_000_000, "got {out}");
    }

    #[test]
    fn slippage_only_ever_lowers_the_floor() {
        let none = oracle_min_out(SIDE_BUY, USDC_500, P, 0).unwrap();
        let some = oracle_min_out(SIDE_BUY, USDC_500, P, 50).unwrap();
        let lots = oracle_min_out(SIDE_BUY, USDC_500, P, 9_999).unwrap();
        assert!(lots < some && some < none);
    }

    #[test]
    fn refuses_inputs_that_would_make_the_floor_meaningless() {
        assert!(oracle_min_out(SIDE_BUY, USDC_500, 0, 50).is_err(), "zero price");
        assert!(oracle_min_out(SIDE_BUY, USDC_500, P, 10_000).is_err(), "100% slippage");
        assert!(oracle_min_out(0, USDC_500, P, 50).is_err(), "HOLD is not tradeable");
        assert!(oracle_min_out(9, USDC_500, P, 50).is_err(), "unknown side");
    }

    #[test]
    fn does_not_overflow_on_absurd_amounts() {
        // u64::MAX * 1e9 overflows u128 only above ~3.4e29; check it is handled
        // rather than wrapping into a tiny, trivially-satisfied floor.
        let r = oracle_min_out(SIDE_BUY, u64::MAX, 1, 0);
        assert!(r.is_err(), "expected overflow, got {r:?}");
    }
}
