use anchor_lang::prelude::*;

/// Seed prefix for the per-owner vault config PDA.
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed prefix for a vault's encrypted strategy.
pub const STRATEGY_SEED: &[u8] = b"strategy";

/// Encrypted scalars in a strategy: entry_below, exit_above, stop_below, size_bps.
/// Fixed because Arcis circuits are fixed-shape (RESEARCH.md §2.7).
pub const STRATEGY_FIELDS: usize = 4;

/// Seed prefix for a vault's pending trade authorization.
pub const INTENT_SEED: &[u8] = b"intent";

/// How long a trade authorization stays executable, in slots (~72 s at 400 ms).
///
/// Deliberately short. The intent is public between the callback writing it and
/// an executor consuming it, so the window is also the window in which someone
/// can position against it (THREAT_MODEL T-27, T-28). Long enough to land a
/// transaction, short enough that a stale decision cannot be executed against a
/// market that has moved.
pub const INTENT_TTL_SLOTS: u64 = 180;

/// The Arcium cluster this vault will accept results from.
///
/// **Custody-critical.** Arcium's generated constraint derives the cluster
/// account from the MXE account, so it silently follows a `migrate-cluster`.
/// `verify_output` then validates the BLS signature against *whatever cluster is
/// passed*, which would let an operator who migrated the MXE to a cluster they
/// control mint attestations this program accepts as genuine MPC results — that
/// is, forge trade authorizations.
///
/// Pinning it to a constant closes that. Changing it requires a program upgrade,
/// which a timelocked upgrade authority makes public and delayed.
/// See ARCHITECTURE.md §7.1 and THREAT_MODEL.md T-37.
///
/// This constant carried no `#[cfg]` until now, and a second
/// `EXPECTED_CLUSTER_OFFSET_MAINNET` sat beside it that nothing ever read. A
/// `--features mainnet` build therefore pinned the *devnet* cluster — the one
/// failure this constant exists to prevent, on the build where it matters.
#[cfg(not(feature = "mainnet"))]
pub const EXPECTED_CLUSTER_OFFSET: u32 = 456;
#[cfg(feature = "mainnet")]
pub const EXPECTED_CLUSTER_OFFSET: u32 = 2026;

/// Wrapped SOL. Same address on every cluster.
pub const BASE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// USDC on mainnet; a test mint on devnet.
///
/// Circle holds the mint authority for devnet USDC (`4zMMC9sr…`), so a test
/// cannot fund a vault with it — and a vault holding nothing evaluates every
/// strategy to a zero-sized trade, which leaves the authorization path
/// unexercised. This mint is ours, 6 decimals like USDC, so devnet tests can
/// mint what they need. It is a fixture, not a claim about liquidity: nothing
/// off devnet references it, and the mainnet arm below is untouched.
#[cfg(not(feature = "mainnet"))]
pub const QUOTE_MINT: Pubkey = pubkey!("36X5x8D8jc15XD971iSC9cAB5puaA7zXc6dggA96rxbw");
#[cfg(feature = "mainnet")]
pub const QUOTE_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// GUARDIAN — REMOVED, deliberately.
//
// It was a placeholder set to this program's own id, which is also the public
// key of `target/deploy/vault-keypair.json`. That file is the deploy keypair,
// so the "guardian" was not an inert placeholder: whoever holds it could pause
// any user's vault in this program, indefinitely, without the owner's consent.
//
// The damage was bounded — `withdraw` ignores status entirely (see lib.rs) and
// only the owner can resume — so it was griefing rather than theft. But a
// system whose central claim is that the operator holds no unilateral lever
// cannot ship an accidental one, and a guardian nobody holds a *separate* key
// for protects nothing anyway.
//
// Pausing is owner-only until a real guardian key exists — a multisig that is
// demonstrably not the deployer. Re-adding it means adding a constant here AND
// restoring the branch in `pause`, so neither happens by accident.

/// Jupiter aggregator — the only program `execute_trade` will ever CPI into.
///
/// Read from the live `GET /swap/v2/build` response's `swapInstruction.programId`;
/// Jupiter's docs pages do not publish it. Same address on devnet, though devnet
/// has no routable liquidity (RESEARCH §4.4).
///
/// Pinned as a constant on purpose. Accepting a swap program id from instruction
/// data would make this an arbitrary CPI executor, which is the single most
/// dangerous thing a vault can expose. See THREAT_MODEL T-2.
pub const JUPITER_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// `TradeIntent.side` values. 0 never reaches an intent — HOLD writes nothing.
pub const SIDE_BUY: u8 = 1;
pub const SIDE_SELL: u8 = 2;

/// Decimals of the two mints, used to convert an oracle price into an expected
/// output amount. wSOL is 9, USDC is 6.
pub const BASE_DECIMALS_POW: u128 = 1_000_000_000;

/// Basis-point denominator.
pub const BPS_DENOMINATOR: u16 = 10_000;

// Risk-limit bounds, enforced at vault creation. These cap how much rope a user
// can give their own bot; they are not a substitute for the per-trade checks
// that arrive with `execute_trade`.
pub const MAX_TRADE_BPS_CEILING: u16 = 5_000; // never more than 50% of the vault per trade
pub const MAX_SLIPPAGE_BPS_CEILING: u16 = 500; // 5%
/// Ceilings on the *oracle* limits, tightened to exactly what `oracle.rs`
/// enforces.
///
/// They were 120s and 500bps while `read_sol_usd_price` enforced 30s and
/// 100bps from its own constants, so a vault could be configured 4x staler and
/// 5x wider than anything the code would ever accept. Setting the ceilings to
/// the enforced values makes the per-vault fields honest: they can only ever be
/// stricter than the floor the program already applies.
pub const MAX_ORACLE_STALENESS_CEILING: u32 = 30; // seconds; == oracle::MAX_PRICE_AGE_SECONDS
pub const MAX_CONF_BPS_CEILING: u16 = 100; // == oracle::MAX_CONF_BPS

/// Upper bound on the cooldown. `validate()` never bounded this field at all.
///
/// Deliberately short. A cooldown only delays *entries* (sells are exempt), but
/// a long one still means paying for MPC evaluations that mint intents nothing
/// can execute, since an intent lives ~72 seconds.
pub const MAX_COOLDOWN_SECONDS: u32 = 3_600;
pub const MAX_ORACLE_DEVIATION_CEILING: u16 = 1_000; // 10%
