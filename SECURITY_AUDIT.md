# SECURITY_AUDIT.md

What each control in [`THREAT_MODEL.md`](THREAT_MODEL.md) is actually worth,
graded by a single question:

> **would a test fail if the mitigation were deleted?**

That question is harsher than "is there a test", and deliberately so. Several
rows that looked covered did not survive it. The audit that produced this ran
five independent reviewers over the threat list and then an adversarial pass
whose job was to refute their optimistic gradings; it downgraded six.

No third party has reviewed any of this. It is a self-audit, and the most
serious finding in it (T-3) is one this repo cannot fix from inside.

## Grades

| grade | meaning |
|---|---|
| **ENFORCED** | code exists, and a test detects its removal |
| **CODED** | code exists; deleting it breaks no test |
| **DESIGN** | mitigated by absence — no instruction can do the bad thing |
| **UNVERIFIED** | claimed but absent, or not confirmable from this repo |
| **INHERENT** | cannot be mitigated; must be disclosed instead |

`CODED` is not an accusation. It is the honest majority state of a young
codebase, and the point of writing it down is that "implemented" and "verified"
stop being the same word.

## What the follow-up pass changed

A second pass re-graded the table against the code as it stands, and fixed what
it found. Six items, in descending order of how much they mattered:

1. **A cooldown disabled the stop-loss.** The executor skipped evaluation for
   the whole cooldown window, and evaluation is the only thing that can produce
   a SELL — so the longer an owner set the cooldown for safety, the longer their
   stop was off. The program is deliberately built the other way round (exits
   are exempt from the cooldown); `decide()` now matches it and suppresses
   evaluation only when the vault holds nothing to exit. Detector:
   `executor.ts` — *keeps evaluating during a cooldown while a position is
   open*, confirmed by deleting the guard.
2. **Replacing a strategy did not stop the old one trading.** Authorizations
   bind to `mxe_version`, and `submit_strategy` left the converted copy intact,
   so a replacement changed nothing until a separate conversion landed — and an
   owner submitting a deliberately inert strategy to halt their bot was ignored.
   `state.rs` documented the opposite of what the code did. Submission now
   zeroes the converted copy, failing closed. Detector: `vault.ts` — *retires
   the converted strategy when a replacement is submitted*.
3. **`max_oracle_deviation_bps` was an inert setting.** Settable,
   range-checked, shown in the interface, described in the docs, and read by
   nothing. It is now enforced on entries: an authorization that would fill more
   than the band above the price it was decided at is refused. Exits are exempt
   by design — see below. Detectors: three in `swap-execution.ts`, including one
   asserting an exit still executes after a 50% adverse move.
4. **Both callbacks stamped a version read live.** A submission landing between
   `convert_strategy` and its callback attached the new version to the old
   ciphertext; after fix 2 it would have silently re-armed the strategy the
   owner had just replaced. `convert_strategy` now claims the version when it
   queues, and the callback refuses if it moved. Arming requires the ciphertext
   as well as the version (`StrategyState::is_armed`), so the in-flight window
   is not evaluable.
5. **A test file drove circuits that no longer exist.** `tests/strategy-engine.ts`
   used `HelloArcium` and an `evaluate_strategy` that took the vault's value as
   a caller argument — the exact lie the current design removed. It was matched
   by the default `test` glob, so `npm test` could not pass. Its two unique
   branches (take-profit and stop-loss) were ported to the devnet suite rather
   than dropped; the file is gone.
6. **Four checks had no detector:** `VaultNotActive` on trade, `TradeTooLarge`,
   `InsufficientSourceBalance`, and the cluster pin. The first three now have
   one. The fourth does not, and that is recorded rather than papered over —
   see "the gaps that matter".

## What the first audit changed

It was not a paperwork exercise. It found, and this session fixed:

- **The single most dangerous untested line.** `dst_after - dst_before >=
  min_out` is the only assertion requiring a swap's proceeds arrive *in this
  vault*. The source-delta check only proves `amount_in` left; the lamports
  check covers rent. A route that spends the authorized amount and delivers
  elsewhere satisfies both — and since exits are uncapped by design, that is
  the entire base balance, spendable by anyone because `execute_trade` is
  permissionless. `SlippageExceeded` appeared zero times in `tests/`. It now
  has a detector.
- **A live confidentiality defect in shipped frontend code.** `fetchMxePublicKey`
  falls back to a fixed public constant on any error, and the submit path
  guarded on `!mxe` rather than `!mxe.live`. With a real MXE deployed, that
  branch is no longer a visible dev state — it is what a transient RPC failure
  looks like, and it would have encrypted a strategy to a key in this repo
  while the UI said "encrypted on chain". Now refuses to submit.
- **A test of mine that proved nothing.** `does_not_overflow_on_absurd_amounts`
  claimed to show a `checked_mul` was load-bearing. `u64::MAX * 1e9` is ~1.8e28,
  well inside `u128::MAX` — that multiply cannot overflow, and the test was
  passing on a downstream `u64::try_from` that fires either way. Replaced with
  one that checks what it says.
- **Four §9 obligations that were listed as met and had no test at all** —
  expired intent, superseded nonce, non-allowlisted mint, fill below floor.
  All four now have detectors.
- **Two stale status headers** claiming "pre-implementation" and "no code has
  been written", months after both stopped being true. A disclaimer nobody
  updates teaches readers to discount the document.

## Per-threat evidence

"Test" names the detector, not merely a test that touches the area.

| ID | Threat | Grade | Code | Detector |
|---|---|---|---|---|
| T-1 | Operator withdraws user funds | ENFORCED | `lib.rs:149-179`, `lib.rs:804-837` | `vault.ts` |
| T-2 | Operator drains funds via a crafted "trade" | ENFORCED | `constants.rs:90`, `lib.rs:1121` | `swap-execution.ts` |
| T-3 | Operator upgrades the program to add a backdoor | **UNVERIFIED** | none — no in-program fix exists | — |
| T-4 | Operator front-runs a withdrawal by pausing | ENFORCED | `lib.rs:149-179`, `lib.rs:143-148` | `vault.ts` |
| T-5 | Malicious user drains another user's vault | ENFORCED | `lib.rs:760-766`, `lib.rs:774-779` | `vault.ts` |
| T-6 | Arithmetic overflow/underflow | CODED | `lib.rs:103`, `oracle.rs:82-86` | — |
| T-7 | Operator recovers strategies via migrate-cluster ( | CODED | `lib.rs:486-489`, `lib.rs:596-599` | — |
| T-8 | Backend sees plaintext strategy | DESIGN | `packages/sdk/src/encrypt.ts:100-125`, `web/app/page.tsx:60-73` | — |
| T-9 | Threshold inference from public trades | INHERENT | `ixs:lib.rs:155`, `lib.rs:625-643` | — |
| T-10 | Single node reads a strategy | **UNVERIFIED** | `lib.rs:453-459`, `lib.rs:541-551` | — |
| T-11 | All cluster nodes collude | INHERENT | — | — |
| T-12 | Timing side channel reveals which branch fired | DESIGN | `ixs:lib.rs:117-155`, `packages/types/src/strategy.ts:196-200` | — |
| T-13 | Operator silently swaps a user's strategy | ENFORCED | `lib.rs:1157-1179`, `lib.rs:213` | `vault.ts` |
| T-40 | A strategy replaced mid-conversion is re-armed by the in-flight callback | CODED | `convert_strategy` claims the version; callback checks it; `is_armed()` | Rust unit tests only — the callback cannot be invoked off-cluster |
| T-14 | Strategy replay — reactivating an old strategy | ENFORCED | `submit_strategy` zeroes the converted copy | `vault.ts` |
| T-15 | Malicious frontend exfiltrates plaintext before en | **UNVERIFIED** | `web/app/page.tsx:60-71`, `packages/sdk/src/encrypt.ts:100-125` | — |
| T-16 | Hostile RPC feeds fake state | **UNVERIFIED** | `web/components/wallet-context.tsx:16-17` | — |
| T-17 | XSS | DESIGN | `web/components/receipts.tsx:41` | — |
| T-18 | Malicious wallet | INHERENT | `lib.rs:716`, `lib.rs:658-661` | — |
| T-19 | One node aborts computations (DoS) | CODED | `lib.rs:230-231`, `lib.rs:263-276` | — |
| T-20 | Forged callback | CODED | `lib.rs:601-607`, `lib.rs:491-498` | — |
| T-21 | Computation expires unfinalized | **UNVERIFIED** | `constants.rs:24`, `lib.rs:274` | — |
| T-22 | Cluster unavailable | ENFORCED | `lib.rs:149-179`, `lib.rs:804-837` | `trade-authorization.ts` |
| T-23 | Callback exceeds 1,232 bytes (OutputTooLarge) | DESIGN | `ixs:lib.rs:108-114`, `lib.rs:609-610` | — |
| T-24 | Stale oracle triggers a bad trade | CODED | `oracle.rs:66-75`, `lib.rs:533` | — |
| T-25 | Wide confidence interval (illiquid/volatile) | CODED | `oracle.rs:82-87`, `oracle.rs:40` | — |
| T-26 | DEX price manipulation to trigger a stop | CODED | `lib.rs:533`, `lib.rs:546` | — |
| T-27 | Sandwich attack on our swap | CODED | `lib.rs:335-336`, `lib.rs:395-398` | — |
| T-28 | Intent visible between callback and execution | CODED | `constants.rs:24`, `lib.rs:632` | — |
| T-29 | Liquidity disappears / route fails | CODED | `lib.rs:373`, `lib.rs:407-408` | — |
| T-30 | Rapid price movement between decision and execution | ENFORCED | `lib.rs` deviation band, `state.rs` `oracle_price` | — |
| T-31 | Repeated triggering drains value via fees/slippage | ENFORCED | `lib.rs:312-331`, `lib.rs:414` | `swap-execution.ts` |
| T-32 | Replay of an old trade action — four layers: consu | ENFORCED | `lib.rs:263` | `swap-execution.ts` |
| T-33 | Fake/spoofed computation result — BLS verify_outpu | CODED | `lib.rs:491-497`, `/.cargo/registry/.../arcium-anchor-0.14.1/src/lib.rs:279-287` | — |
| T-34 | Unauthorized signer submits a trade — executor is  | DESIGN | `lib.rs:1085` | — |
| T-35 | Trade exceeding limits — max_trade_bps and cooldown | ENFORCED | `lib.rs:312-318`, `state.rs:27-44` | `swap-execution.ts` |
| T-36 | Arbitrary CPI / arbitrary program execution — pinn | ENFORCED | `lib.rs:362`, `constants.rs:90` | `swap-execution.ts` |
| T-37 | Operator forges trade authorizations via a migrate | CODED | `lib.rs:486-489`, `constants.rs:43-46` | — |
| T-38 | size_bps fully recoverable from a single trade — m | ENFORCED | `constants.rs:12`, `state.rs:54-62` | `encryption.ts` |
| T-39 | Trade size distinguishes a stop from a take-profit | INHERENT | `ixs:lib.rs:145-153`, `ixs:lib.rs:123-130` | — |

## The gaps that matter, in order

**1. T-3 — the upgrade authority is a single hot key.** Verified live, not
assumed: `solana program show` reports authority
`Cbdvwy6Dm7tbCsLP3nw4Umz29BLNQkNwCBDDDRrkbpTZ`, and that account is
system-owned — a plain keypair, not a multisig. Whoever holds it can replace
`withdraw` with a version that pays an operator. **Every other finding in this
document is conditional on that key.** Nothing in the repo prevents a mainnet
deploy that keeps it hot; the control is a checklist line, not a gate. The
cheapest real fix is a deploy script that refuses unless the authority equals a
known multisig.

**2. Cluster pinning (T-37) has no runtime detector, and this is the second
attempt at saying so.** The first version of that test asserted the IDL carried
a `clusterAccount`, which Arcium's macro emits unconditionally; a mutation run
confirmed it passed with the pin deleted. It has been replaced by a test that
claims only what it checks, plus Rust unit tests proving the derivation and the
per-network split. The call site itself is unverified: invoking a callback with
a foreign cluster needs a `SignedComputationOutputs<O>` value, and Anchor's
TypeScript coder cannot build that generic enum — hand-encoding the `Failure`
variant is refused with `InstructionDidNotDeserialize`. Every other Arcium
account constraint must also pass before the handler runs. This is the most
custody-critical check in the program and it is graded CODED, not ENFORCED.

**3. The swap path's coverage is fork-gated.** Everything proving the CPI is
safe lives in `tests/swap-execution.ts`, which self-skips unless run against a
surfpool mainnet fork with `--features mainnet`. A default `anchor test` run
exercises none of it. The tests are real; the risk is that a green run means
less than it appears.

**4. Confidentiality is bounded by inference, not by cryptography.** T-9 is
inherent and now sharper, not softer: `size_bps` is public (T-38, deliberately)
and a full-exit sell is distinguishable from a partial take-profit (T-39), so
each evaluation yields a labelled inequality rather than an ambiguous one.
Thresholds narrow in days for an active bot. This is disclosed in
[`docs/what-is-private.md`](docs/what-is-private.md) and must stay disclosed.

**5. Several mitigations are described in the present tense and do not exist.**
Still absent: jittered cadence, randomised size, SRI, reproducible builds,
published hashes, `tx.jup.ag` submission. Two items have since moved off this
list — a CSP is served (`apps/web/next.config.mjs`) and the post-swap deviation
band now exists — and `THREAT_MODEL.md` marks the rest as not implemented
rather than describing them as shipped.

The CSP is worth reading before counting on it: `script-src` carries
`'unsafe-inline'` and `'unsafe-eval'`, which Next.js needs without a nonce
pipeline. It bounds `connect-src`, which is the part that matters for
exfiltration, and it is close to useless against injected script. T-17 is graded
DESIGN on React's escaping, not on this header.

## What this audit does not cover

- No third-party review, no fuzzing, no formal verification.
- `verify_output()` cannot be unit-tested — a dummy signature always fails — so
  BLS attestation is exercised only against the live devnet cluster.
- The Arcium privacy claim (1-of-n honest) is a vendor property reproduced from
  their documentation, not something this project can verify.
- No mainnet deployment exists, and this document is not a recommendation to
  create one.
