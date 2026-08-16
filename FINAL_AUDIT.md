# FINAL_AUDIT.md

The last pass over SilentEdge before it is handed back. It re-read the code
against every claim made about it — in the program's own comments, in the
interface, and in the documents — and fixed what did not hold.

One question decided every grade, the same one [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md)
uses:

> **would a test fail if the mitigation were deleted?**

Where the answer was no, the finding is written down as no. Nothing here is
graded on the code looking right.

---

## What this is not

- **Not a third-party audit.** It is a self-audit, and self-audits have a known
  bias. The most serious finding in the project (T-3, below) is one this repo
  cannot fix from inside, and it is unfixed.
- **Not a mainnet readiness statement.** Nothing has been deployed to mainnet.
  Two blockers in [`MORNING_INPUT.md`](MORNING_INPUT.md) need a person.
- **Not complete coverage.** Named gaps are listed at the end rather than
  omitted.

---

## The eight findings that were real

Ordered by what they would have cost a user.

### 1. A cooldown disabled the stop-loss

**Severity: high. Fixed.**

`decide()` skipped evaluation for the entire cooldown window. Evaluation is the
only thing that can produce a SELL, so the vault could not generate an exit for
the whole window — the longer an owner set the cooldown for safety, the longer
their stop was disarmed.

The program is deliberately built the other way round: exits are exempt from
both the cooldown and the size cap, because a stop sells the whole position and
a cap can never exceed half of it. The executor reintroduced off chain exactly
the delay the program went out of its way to remove.

Evaluation is now suppressed only when the vault holds nothing to exit. An
occasional wasted computation fee is the right trade against a silently
disarmed stop.

- Fix: `packages/sdk/src/decide.ts`, `apps/api/src/executor.ts`
- Detector: `tests/executor.ts` — *keeps evaluating during a cooldown while a
  position is open*. Paired with a flat-vault case in the same test, so it
  asserts the asymmetry rather than "cooldowns are ignored".
- Mutation-checked: deleting the guard turns it red.

### 2. Replacing a strategy did not stop the old one trading

**Severity: high. Fixed.**

Trade authorizations bind to `mxe_version`, and `submit_strategy` left
`mxe_ciphertexts` and `mxe_version` untouched. Submitting a replacement
therefore changed nothing until a separate conversion landed — the previous
strategy kept trading, and an owner submitting a deliberately inert strategy to
halt their bot was ignored.

`state.rs` documented the opposite of what the code did, which is how it
survived: the comment on `version` claimed replacing a strategy invalidated
work in flight, and nothing binds to `version`.

Submission now zeroes the converted copy. It fails closed — `evaluate_strategy`
refuses an unarmed strategy, so trading halts until the owner converts the
replacement. For a strategy the user just replaced, "no strategy" is the
correct state.

- Fix: `programs/vault/src/lib.rs` (`submit_strategy`), `state.rs`
- Detector: `tests/vault.ts` — *retires the converted strategy when a
  replacement is submitted*. It seeds a converted strategy with a surfpool
  cheatcode, asserts the fixture armed it, then asserts submission disarms it.
- Mutation-checked: it failed against the previous bytecode before redeploy.

### 3. `max_oracle_deviation_bps` was an inert setting

**Severity: medium-high. Fixed.**

Settable, range-checked on write, displayed in the interface, described in
`ARCHITECTURE.md` — and read by no instruction. A number that looks like a risk
control and is not one is worse than its absence, because it is priced into a
user's decision to deposit.

It is now enforced: an entry that would fill more than the band above the price
its decision was made at is refused. This bounds staleness of the *decision*,
which nothing else did — `min_amount_out` is re-derived from a fresh oracle read
and so always tracks the market, and `expires_at_slot` bounds elapsed slots, not
elapsed price. Without it, an executor could hold an authorization for its whole
window and fire it after a large move.

Entries only, and only against a rising price, for the same reason as the cap
and the cooldown. A stop fires *because* the price fell; refusing to execute it
because the price fell further would disarm the vault's only downside control in
exactly the move it exists for. That is the shape of a defect this project has
already shipped once — the size cap rejected every stop-loss until it was found
— so the asymmetry has its own test.

- Fix: `programs/vault/src/lib.rs` (`execute_trade`)
- Detectors: `tests/swap-execution.ts` — *refuses an entry filled far above the
  price it was decided at*, *allows an entry that moved less than the band*, and
  *never blocks an exit, however far the price has fallen*.

### 4. Both callbacks stamped a version read live

**Severity: medium. Fixed.**

`store_strategy_v2_callback` set `mxe_version = strategy.version`, read at
callback time rather than at queue time. A submission landing in between
attached the *new* version to the *old* ciphertext.

Finding 2's fix made this worse rather than better: with submission now zeroing
the converted copy, an in-flight callback would have silently re-armed the
strategy the owner had just replaced.

`convert_strategy` now claims the version when it queues the computation, and
the callback refuses if it moved. Because the claim is written before the
ciphertext exists, arming had to stop meaning "version is non-zero" — hence
`StrategyState::is_armed()`, which requires the ciphertext too. Without that,
an evaluation queued inside the in-flight window would have run against 96 zero
bytes as though they were a strategy.

- Fix: `programs/vault/src/lib.rs`, `state.rs`, new `StrategySuperseded` error
- Detector: Rust unit tests for `is_armed()` only. The supersession check itself
  is **CODED, not ENFORCED** — the callback cannot be invoked off-cluster, for
  the reasons in finding 8.

### 5. "Converted" was read from a field set before conversion

**Severity: medium. Found by finding 4's own fix, and fixed.**

Making `convert_strategy` claim the version at queue time (finding 4) meant
`mxe_version` goes non-zero the moment the queueing transaction lands — before
the cluster has produced anything. Three places treated a non-zero version as
"converted":

- the devnet suite's conversion wait, which returned immediately and left every
  later test failing with `StrategyNotConverted`;
- the executor, which would have paid for a computation that cannot succeed;
- **the interface, which would have shown "armed (v2)" while the strategy was
  still converting** — the premature claim that the polling exists to prevent.

The ciphertext is the only honest signal that the callback ran, and all three
now test for it. The chain was never wrong — `evaluate_strategy` refuses via
`is_armed()` — but three clients would have said otherwise.

This one is worth reading as a pattern rather than a bug: a field's meaning
changed, the compiler could not see it, and the failure mode of two of the three
call sites was a false reassurance rather than an error.

- Fix: `packages/sdk/src/decide.ts` (`StrategyView.armed`),
  `apps/api/src/executor.ts`, `apps/web/lib/vault-program.ts`,
  `tests/trade-authorization-devnet.ts`
- Detector: `tests/executor.ts` — the conversion-gate test now includes a
  `mxeVersion: 7, armed: false` case, which is exactly the in-flight window.

### 6. A test that proved nothing, and a test file that could not run

**Severity: medium (process). Fixed.**

The cluster-pinning test asserted that the IDL contained a `clusterAccount`.
Arcium's macro emits that unconditionally. A mutation run confirmed the test
passed with the pin deleted — it was decoration on the single most
custody-critical check in the program. See finding 8 for where that landed.

Separately, `tests/strategy-engine.ts` drove `anchor.workspace.HelloArcium` and
an `evaluate_strategy` that took the vault's value as a caller argument — the
precise lie the current design removed by reading balances on chain. It matched
the default `test` glob, so `npm test` could not pass. Its two unique branches,
take-profit and stop-loss, were the only coverage those circuit paths had; they
were ported to the devnet suite rather than dropped, and the file was deleted.

- Detectors added: `tests/trade-authorization-devnet.ts` — *authorizes a sell
  when the price is above the exit threshold* (which also asserts the sell is
  sized from the **base** balance, the specific defect of denominating a SOL
  sale in USDC) and *exits the whole position when the stop is hit*.

### 7. Four enforced checks had no detector

**Severity: medium. Three fixed.**

`VaultNotActive` on trade, `TradeTooLarge`, and `InsufficientSourceBalance` were
all real code with nothing testing them. The pause check matters most: with a
permissionless executor, pausing is the only way an owner can halt a running
strategy without withdrawing.

- Detectors added: `tests/swap-execution.ts` — *refuses to trade a paused
  vault* (which also asserts the brake releases, so it cannot pass by confusing
  pause with stop), *refuses an entry above the per-trade cap* (one unit over
  the line, so it cannot pass against a much looser cap), and *refuses to spend
  more than the vault holds*.
- Still without one: `VaultLamportsChanged`. It needs a route that alters the
  vault PDA's lamports, which cannot be constructed against a real Jupiter
  route. Recorded, not fixed.

### 8. Cluster pinning still has no runtime detector

**Severity: high. NOT fixed — recorded.**

This is the honest finding and the one to read twice.

T-37 is the most custody-critical check in the program. Arcium derives
`cluster_account` from `mxe_account`, so it silently follows a migrate-cluster,
and `verify_output()` then validates a BLS signature against whatever cluster it
is handed. The pin is what stops an operator who migrated the MXE from minting
attestations this program accepts as genuine.

Four attempts at a genuine detector failed:

1. IDL-only assertion — **proven fake by mutation test**.
2. Building the argument with Anchor's TypeScript coder —
   `SignedComputationOutputs<O>` is a generic enum and the coder cannot encode it.
3. Placeholder accounts — fails earlier, on the missing comp-def account.
4. Hand-encoding the `Failure` variant as `DISC + [1]` —
   `InstructionDidNotDeserialize`.

Every other Arcium account constraint must also pass before the handler runs at
all, so there is no cheap path in.

What exists instead, and what it is worth: Rust unit tests prove the derivation
(`expected_cluster()` is that PDA and no other, and a different offset gives a
different account) and prove the devnet and mainnet constants are distinct — the
constant carried no `#[cfg]` for several phases, so a mainnet build pinned the
devnet cluster, which is the exact failure the constant exists to prevent. The
TypeScript test now asserts only that both callbacks take a cluster account, and
its doc comment says plainly that it does not detect the pin's removal.

**Graded CODED, not ENFORCED.** A fifth fake test would have been worse than
none.

---

## Where it stands

Every suite was run after the last change, in the environment it needs. The
figures are what the run printed, not a summary of intent.

| suite | environment | result |
|---|---|---|
| `cargo test -p vault --lib` | none | **16 passing** |
| `npm run test:pure` | none | **61 passing** |
| `npm run test:local` | surfpool devnet fork | **46 passing** |
| `npm run test:devnet` | devnet + Arcium cluster 456 | **12 passing** |
| `npm run test:fork` | surfpool mainnet fork, `--features mainnet` | **20 passing** |

155 in total, 0 failing. Two results are worth naming individually because they
run against the live cluster rather than a fixture:

- *authorizes a sell when the price is above the exit threshold* — live price
  $74.52, exit threshold $64.52, authorized 2,000,000 lamports against a
  20,000,000 lamport position. Ten percent, sized from the **base** balance.
- *exits the whole position when the stop is hit* — live price $74.53, stop
  $79.53, authorized the full 20,000,000. The stop's asymmetry, proven rather
  than asserted.

Three fixes were mutation-checked — the change was reverted, the suite re-run,
and the relevant test confirmed to fail: the cooldown guard (finding 1), the
strategy retirement (finding 2, which failed against the pre-fix bytecode), and
the deviation band (finding 3, rebuilt and redeployed with the check disabled).
The cluster pin was mutation-checked too, and **failed** the check — which is
finding 8.

The web app builds clean.

---

## What did not change, and why

**T-3, the upgrade authority, is still a single hot key.** It is
system-owned — a plain keypair. Whoever holds it can replace `withdraw` with a
version that pays an operator, which makes every other finding here a statement
about today's bytecode rather than about the project. Fixing it means creating a
multisig and choosing its signers and threshold: an ownership decision, not an
engineering one, and irreversible in the direction that matters.
`scripts/check-upgrade-authority.mjs` is built and currently exits 1. See
[`MORNING_INPUT.md`](MORNING_INPUT.md) §1.

**There is still no protocol fee.** Every fee mechanism is structurally a third
way for value to leave a vault, alongside the swap and the owner's withdrawal,
and adding one silently would invalidate the custody claim the rest of the
project rests on. It also needs a treasury address that a person has decided on.
See [`MORNING_INPUT.md`](MORNING_INPUT.md) §2 and [`FEES.md`](FEES.md).

**The privacy limits are inherent, not pending.** Trades are public; enough of
them narrow the encrypted thresholds. `size_bps` is public by design (T-38) and
a full-position exit is distinguishable from a partial take-profit (T-39), so
each evaluation yields a labelled inequality rather than an ambiguous one. This
is disclosed on the landing page, in the app, and in
[`docs/visibility.md`](docs/visibility.md), and it must stay disclosed.

**No mainnet deploy was attempted, no credentials were invented, and no
irreversible action was taken** beyond devnet deploys and devnet transfers.

---

## Documentation corrected

Prose that describes a guarantee the code does not provide is the same defect as
a comment that does, and it is harder to catch because nothing compiles it.

- **`ARCHITECTURE.md` still said "Status: PROPOSED. No implementation has
  begun."** It is now marked as the design record it is, with the three places
  the build diverged from it listed at the top: `size_bps` shipped public, the
  post-swap deviation band did not exist (it does now, see finding 3, and the
  divergence note records that it was absent when the document claimed it), and
  account count is bounded by `onlyDirectRoutes` rather than `maxAccounts`.
- **`ARCHITECTURE.md` §8 listed `size_bps` as private.** It is public.
- **`state.rs` claimed `version` invalidated work in flight.** Nothing binds to
  `version`. Corrected alongside finding 2.
- **`TradeIntent.min_amount_out` was documented as "NOT YET ENFORCED".** The
  floor is enforced, but from a *fresh* oracle read rather than from this field
  — the comment described a design that had been superseded in the safer
  direction. Corrected to say which number is the enforced one.
- **`SECURITY_AUDIT.md` listed CSP among mitigations claimed but absent.** A CSP
  is served. Its `script-src` carries `'unsafe-inline'` and `'unsafe-eval'`,
  which is now stated, because that makes it close to useless against injected
  script — it bounds `connect-src`, which is the part that matters for
  exfiltration, and T-17 is graded on React's escaping rather than on the header.

---

## Interface corrections

- **Saving a strategy could fail silently.** `encryptAndSubmit` returned without
  a message when the wallet could not sign messages — and the signature is what
  derives the encryption key. Pressing Save did nothing, with no error. It now
  says which precondition failed.
- **The risk panel claimed two unenforced limits.** After finding 3 there is
  one: the daily loss limit. The panel now says so, and says why exits are
  exempt from the band.
- **Conversion polling compared against remembered state.** It waits for a
  non-zero on-chain version instead, which is unambiguous now that submission
  zeroes it.

---

## Known gaps

Written down rather than closed:

1. **Cluster pinning has no runtime detector** (finding 8). CODED.
2. **The callback supersession check has no runtime detector** (finding 4), for
   the same structural reason. CODED.
3. **`VaultLamportsChanged` has no detector** (finding 7).
4. **The swap suite is fork-gated.** Everything proving the CPI is safe needs a
   surfpool mainnet fork and a `--features mainnet` build. A default run
   exercises none of it — the tests are real, the risk is that a green run
   without the fork means less than it appears.
5. **`verify_output()` cannot be unit-tested.** A dummy signature always fails,
   so BLS attestation is exercised only against the live devnet cluster.
6. **The Arcium 1-of-n honest-majority privacy claim is a vendor property**
   reproduced from their documentation. This project cannot verify it.
7. **No third-party review, no fuzzing, no formal verification.**
