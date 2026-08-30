# Security

Threat model, graded controls, test evidence and disclosure policy. Replaces
`SECURITY.md`, `SECURITY.md` and `SECURITY.md`.

## Status

| | |
|---|---|
| Deployed | devnet only. `J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ` |
| Mainnet | no deploy exists, and this document is not a recommendation to create one |
| Review | self-audited. **No third party has reviewed any of this.** No fuzzing, no formal verification |
| Upgrade authority | **a single hot key** (T-3). Every other claim here is conditional on it |
| Tests | 155 passing, 0 failing, across five environments — §1 |

Self-audits have a known bias. The most serious finding (T-3) is one this repo
cannot fix from inside, and it is unfixed.

---

## 1. The evidence

Every suite was run after the last change, in the environment it needs. These
are the figures the runs printed, not a summary of intent.

| suite | environment | result |
|---|---|---|
| `cargo test -p vault --lib` | none | **16 passing** |
| `npm run test:pure` | none | **61 passing** |
| `npm run test:local` | surfpool devnet fork | **46 passing** |
| `npm run test:devnet` | devnet + Arcium cluster 456 | **12 passing** |
| `npm run test:fork` | surfpool mainnet fork, `--features mainnet` | **20 passing** |

**155 in total, 0 failing.** The web app builds clean.

### Mutation-checked, not merely green

Each fix was verified by reverting it, re-running the suite, and checking that
the test went red.

| fix | mutation applied | result |
|---|---|---|
| Cooldown no longer disarms the stop-loss | guard deleted | red |
| Strategy replacement retires the old converted copy | run against pre-fix bytecode | red |
| Oracle deviation band on entries | redeployed with the check disabled | red |
| **Cluster pin (T-37)** | pin deleted | **still passed — the detector was fake. §4.2** |
| **Oracle deviation band, re-checked** | wiring removed | **still passed — the detector was also fake. §4.3** |

### Two results against the live cluster, not a fixture

From `npm run test:devnet` (devnet + Arcium cluster 456):

- *authorizes a sell when the price is above the exit threshold* — live price
  $74.52, exit threshold $64.52, authorized 2,000,000 lamports against a
  20,000,000 lamport position. Ten percent, sized from the **base** balance.
- *exits the whole position when the stop is hit* — live price $74.53, stop
  $79.53, authorized the full 20,000,000. The stop's asymmetry, proven rather
  than asserted.

---

## 2. The custody model

Value leaves a vault two ways: the owner withdraws it, or a swap moves it
between the vault's own two token accounts. No third path exists, because there
is no protocol fee.

**No instruction in the deployed program accepts an operator authority.**
`withdraw` requires the `owner` signature and sends only to `owner`; the
destination is not a parameter. Vault PDAs are seeded by `owner`, with Anchor
`has_one` on every account and ATA ownership asserted.

`withdraw` touches **no Arcium account and no MagicBlock account** — only the
vault config, the vault's two PDA-owned ATAs, the owner's ATA, the owner's
signature and the SPL Token program. It therefore survives a halted cluster,
offline Arx nodes, a closed or migrated MXE, cluster pinning rejecting every
evaluation, our backend and executor vanishing, and Jupiter being unavailable.
`pause` blocks new trades and explicitly does **not** block `withdraw`.

**The swap CPI is not an arbitrary CPI executor.** The route is not validated —
parsing an aggregator's instruction data is a losing game. Instead the swap
program id is a compiled-in constant, both ATAs are derived from `vault_config`,
the output floor comes from an on-chain Pyth read and `max_slippage_bps` rather
than from the caller, and after the CPI returns the program asserts against its
own state:

```
source_before - source_after == amount_in     // exactly the authorized amount left
dest_after - dest_before     >= min_out       // and the proceeds landed here
vault_config.lamports        unchanged        // rent is not a funding source
```

Any route failing to move exactly `amount_in` out and at least `min_out` in
reverts the transaction. Residual, and real: a route can fill anywhere *inside*
the slippage band and pocket the difference. `max_slippage_bps` is the whole
defence there, and it is the owner's setting.

### Deliberately not claimed

| Not claimed | Why |
|---|---|
| The operator can never affect funds | Upgrade authority is one hot key — §4.1 |
| Your strategy is hidden | Trades are public and the thresholds leak — §4.5 |
| Confidentiality from the operator, unconditionally | We hold the MXE authority — §4.3 |
| Resistance to front-running | `TradeIntent` is public before execution; short expiry narrows that window, nothing closes it (T-27, T-28) |
| A stop-loss that always fills | MPC takes seconds. In fast markets the trade fails rather than fills badly — safe, but a failure |

---

## 3. The graded table

Each control is graded by one question, harsher than "is there a test":

> **would a test fail if the mitigation were deleted?**

| grade | meaning |
|---|---|
| **ENFORCED** | code exists, and a test detects its removal |
| **CODED** | code exists; deleting it breaks no test |
| **DESIGN** | mitigated by absence — no instruction can do the bad thing |
| **UNVERIFIED** | claimed but absent, or not confirmable from this repo |
| **INHERENT** | cannot be mitigated; must be disclosed instead |

`CODED` is not an accusation — it is the honest majority state of a young
codebase, and writing it down is what stops "implemented" and "verified" being
the same word. Five reviewers graded this list independently; an adversarial
pass whose job was to refute their optimistic gradings downgraded six rows.
**15 of 40 rows have code with no removal-detector behind it.**

Adversaries assumed: A1 operator (backend, frontend build, executor, RPC; holds
the MXE and upgrade authorities) · A2 one malicious Arx node · A3 n−1 colluding
nodes · A4 all nodes colluding, broken by definition · A5 MEV searcher · A6
inference observer · A7 malicious user · A8 compromised user endpoint.

| ID | Threat | Grade | Detector |
|---|---|---|---|
| T-1 | Operator withdraws user funds | ENFORCED | `vault.ts` |
| T-2 | Operator drains funds via a crafted "trade" | ENFORCED | `swap-execution.ts` |
| T-3 | **Operator upgrades the program to add a backdoor** | **UNVERIFIED** | none — no in-program fix exists |
| T-4 | Operator front-runs a withdrawal by pausing | ENFORCED | `vault.ts` |
| T-5 | Malicious user drains another user's vault | ENFORCED | `vault.ts` |
| T-6 | Arithmetic overflow/underflow | CODED | — |
| T-7 | Operator recovers strategies via `migrate-cluster` | CODED | — |
| T-8 | Backend sees plaintext strategy | DESIGN | — |
| T-9 | Threshold inference from public trades | INHERENT | — |
| T-10 | Single node reads a strategy | **UNVERIFIED** | — |
| T-11 | All cluster nodes collude | INHERENT | — |
| T-12 | Timing side channel reveals which branch fired | DESIGN | — |
| T-13 | Operator silently swaps a user's strategy | ENFORCED | `vault.ts` |
| T-14 | Strategy replay — reactivating an old strategy | ENFORCED | `vault.ts` |
| T-15 | Malicious frontend exfiltrates plaintext pre-encryption | **UNVERIFIED** | — |
| T-16 | Hostile RPC feeds fake state | **UNVERIFIED** | — |
| T-17 | XSS | DESIGN | — |
| T-18 | Malicious wallet (out of scope) | INHERENT | — |
| T-19 | One node aborts computations (DoS) | CODED | — |
| T-20 | Forged callback | CODED | — |
| T-21 | Computation expires unfinalized | **UNVERIFIED** | — |
| T-22 | Cluster unavailable — withdrawal unaffected | ENFORCED | `trade-authorization.ts` |
| T-23 | Callback exceeds 1,232 bytes (`OutputTooLarge`) | DESIGN | — |
| T-24 | Stale oracle triggers a bad trade | CODED | — |
| T-25 | Wide confidence interval (illiquid/volatile) | CODED | — |
| T-26 | DEX price manipulation to trigger a stop | CODED | — |
| T-27 | Sandwich attack on our swap | CODED | — |
| T-28 | Intent visible between callback and execution | CODED | — |
| T-29 | Liquidity disappears / route fails | CODED | — |
| T-30 | Rapid price move between decision and execution | CODED | `wiring.ts` — see §4.3 |
| T-31 | Repeated triggering drains value via fees/slippage | ENFORCED | `swap-execution.ts` |
| T-32 | Replay of an old trade action (four layers) | ENFORCED | `swap-execution.ts` |
| T-33 | Spoofed computation result (BLS `verify_output`) | CODED | — |
| T-34 | Unauthorized signer submits a trade | DESIGN | — |
| T-35 | Trade exceeding limits (entries only) | ENFORCED | `swap-execution.ts` |
| T-36 | Arbitrary CPI / arbitrary program execution | ENFORCED | `swap-execution.ts` |
| T-37 | **Operator forges authorizations via a migrated cluster** | **CODED** | — |
| T-38 | `size_bps` was recoverable from a single trade | ENFORCED | `encryption.ts` |
| T-39 | Trade size distinguishes a stop from a take-profit | INHERENT | — |
| T-40 | Strategy replaced mid-conversion, re-armed by the in-flight callback | CODED | Rust unit tests only — the callback cannot be invoked off-cluster |

"Detector" names the test that fails if the mitigation is deleted, not one that
merely touches the area. T-30's three deviation-band tests in
`swap-execution.ts` turned out **not** to be detectors — see §4.3. Its detectors
are now the wiring guards in `tests/wiring.ts`. `daily_loss_limit_bps` is stored and read by no
instruction: realised P&L is not measurable without putting the oracle on the
withdraw path, and the interface says so.


### 4.3 The deviation band was inert, and its three tests did not notice

**Found 30 August 2026, by re-asking the grading question of a control this
document previously recorded as ENFORCED.**

`max_oracle_deviation_bps` bounds how far the market may move between the moment
the computation decides and the moment the trade fills. `execute_trade` reads
its reference from `trade_intent.oracle_price`, behind a guard:

    if side == SIDE_BUY && intent.oracle_price > 0 {

The callback that creates the intent set that field to zero. The guard was
therefore never true, and the band never applied to a single real trade. A
settable, range-checked, interface-displayed number controlled nothing — which
is the exact defect the earlier pass claimed to have fixed.

**Why three tests passed anyway.** All three deviation tests in
`tests/swap-execution.ts` call a `seedIntent({ oraclePrice })` helper that writes
an intent directly, with a non-zero price. That is a shape the program does not
produce. The tests exercised the arithmetic of the check and never the path that
reaches it, so they were green while the control was absent. This is the second
fake detector in this project, found the same way as the first.

**Fixed.** `evaluate_strategy` now records the price it reads — the price the
decision is actually made at — into `trade_intent.oracle_price` before queueing
the computation, and the callback no longer zeroes it. The callback cannot
supply the value itself: it receives only the computation's output and has no
Pyth account.

**Status: CODED, not ENFORCED. Deployed.** One honest limit remains:

- The new detectors in `tests/wiring.ts` are *source* assertions. They fail if
  either half of the wiring is removed — each was mutation-checked — but they
  are weaker than a runtime detector. The runtime path needs a live Arcium
  cluster, which is the structural reason this survived a full audit.
- ~~The devnet program has not been redeployed with this change.~~
  **Redeployed 30 August 2026**, slot 490235783, signature
  `61SCy7boJQbzdg13uSey9DqywrJSKdZZxKTyrwXYTVwdXnFdjrR5Q9b5MThyuuUjD4T9a983ZKBRDksiE9Lc1EtR`.
  The deployed bytecode was dumped and its SHA-256 compared against the local
  build: identical. The band is live.

**Residual precision limit.** If two evaluations are in flight for one vault at
once, the second overwrites the stashed price before the first callback lands,
so the band is measured against the newer of two recent on-chain reads. Both are
fresh and the window is bounded by `INTENT_TTL_SLOTS`; this is a loss of
precision, not a bypass.

---

## 4. The gaps that matter, in order

### 4.1 T-3 — the upgrade authority is a single hot key

Verified live, not assumed: `solana program show` reports the authority as
`Cbdvwy6Dm7tbCsLP3nw4Umz29BLNQkNwCBDDDRrkbpTZ`, and that account is
system-owned — a plain keypair, not a multisig. Whoever holds it can replace
`withdraw` with a version that pays an operator. **Every other finding here is
conditional on that key.** Nothing in the repo prevents a mainnet deploy that
keeps it hot: the control is a checklist line, not a gate. Fixing it means
creating a multisig and choosing signers and a threshold — an ownership
decision, not an engineering one. §5 has the commands.

### 4.2 T-37 — cluster pinning has no runtime detector

Arcium derives `cluster_account` from `mxe_account`, so it silently follows a
`migrate-cluster`, and `verify_output()` then validates BLS against *that*
cluster. The compiled-in pin is what stops an operator who migrated the MXE from
minting attestations this program accepts as genuine — the most custody-critical
check in the program.

Its first test asserted the IDL carried a `clusterAccount`, which Arcium's macro
emits unconditionally: **a mutation run confirmed it passed with the pin
deleted.** Four attempts at a real detector failed — the IDL assertion (proven
fake); Anchor's TypeScript coder cannot encode the generic enum
`SignedComputationOutputs<O>`; placeholder accounts fail earlier, on the missing
comp-def account; hand-encoding the `Failure` variant as `DISC + [1]` returns
`InstructionDidNotDeserialize`. Every other Arcium constraint must pass before
the handler runs, so there is no cheap way in.

What exists instead: Rust unit tests proving the derivation, and proving the
devnet and mainnet constants differ — the constant carried no `#[cfg]` for
several phases, so a mainnet build pinned the devnet cluster, exactly the
failure it exists to prevent. The TypeScript test now asserts only that both
callbacks take a cluster account, and its doc comment says so. **CODED, not
ENFORCED.** A fifth fake test would have been worse than none.

### 4.3 T-7 — published ciphertext stays decryptable by the MXE authority

We hold the MXE authority. Operator-controlled clusters are a documented Arcium
feature; no CLI command transfers, burns or timelocks that authority, and
Recovery Peers have no documented veto. Pinning makes a migration halt the
system loudly and publicly, but an operator who migrated could still decrypt
strategy ciphertext **already published on chain** — anything the MXE computes
on, the MXE key decrypts, and on-chain data is permanent. Operator-level
strategy confidentiality is trust-based, not cryptographically enforced.

### 4.4 The swap suite is fork-gated

Everything proving the CPI is safe lives in `tests/swap-execution.ts`, which
self-skips unless run against a surfpool mainnet fork with `--features mainnet`.
A default `anchor test` exercises none of it. The tests are real; the risk is
that a green run means less than it appears.

### 4.5 Confidentiality is bounded by inference, not by cryptography

Each evaluation yields a `(price, action)` pair — an inequality. `size_bps` is
public by design (T-38) and a full exit is distinguishable from a partial
take-profit (T-39), so each observation is a *labelled* inequality rather than
an ambiguous one. Bounds tighten roughly logarithmically in the number of
evaluations straddling a threshold: days, not years, for an active bot. Jittered
cadence, randomised sizing and threshold bands are V2 candidates and are **not
implemented**. Nothing prevents this;
[`docs/privacy.md`](docs/privacy.md) has the analysis.

### 4.6 Also named, not closed

- `VaultLamportsChanged` has no detector: it needs a route that alters the vault
  PDA's lamports, which cannot be built against a real Jupiter route.
- T-40's supersession check has no runtime detector, for §4.2's reason.
- `verify_output()` cannot be unit-tested — a dummy signature always fails — so
  BLS attestation runs only against the live devnet cluster.
- Arcium's 1-of-n honest privacy property is a vendor claim from their docs.
  This project cannot verify it.
- Still absent: jittered cadence, randomised size, SRI, reproducible builds,
  published hashes, `tx.jup.ag` submission.
- A CSP **is** served (`apps/web/next.config.mjs`), but its `script-src` carries
  `'unsafe-inline'` and `'unsafe-eval'`, which Next.js needs without a nonce
  pipeline: close to useless against injected script. It does bound
  `connect-src`, the part that matters for exfiltration. T-17 is graded on
  React's escaping, not on this header.
- The frontend sees plaintext by necessity (T-15); a user who does not trust the
  served frontend must self-host.
- Cerberus is detect-and-abort, so any node can abort any computation and
  liveness is not assured (T-19). It fails closed — no result means no trade,
  never a default action — but silence must never be read as HOLD, and that
  monitoring is not built.

---

## 5. Mainnet gates

Not exhaustive; blocking items only.

- [ ] **External audit of the vault program.**
- [ ] **Upgrade authority moved to a timelocked multisig.** Create a Squads
      multisig (https://squads.so) with signers you control, then:
      ```
      solana program set-upgrade-authority J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ \
        --new-upgrade-authority <MULTISIG_PDA>
      ```
- [ ] **That check wired into the deploy pipeline.** It is already built and
      **currently exits 1**, because the authority is a plain keypair today:
      ```
      node scripts/check-upgrade-authority.mjs \
        --rpc "$DEVNET_RPC" --expect <MULTISIG_PDA>
      ```
      A deploy that cannot pass it must not proceed. This is what turns T-3 from
      a checklist line into a gate.
- [ ] Cluster pinning (T-37) verified by a runtime test, negative case included.
- [ ] Emergency withdrawal verified under simulated Arcium unavailability.
- [ ] Full latency benchmark published (p50/p95/worst, failure rate).
- [ ] Q-A resolved with Arcium: can the MXE authority be a multisig? Can
      migration be timelocked?
- [ ] Protocol fee decided. There is none today; adding one creates a third exit
      path, rewrites §2 and needs its own detectors ([`FEES.md`](FEES.md)).
      Blocks a business model, not the MVP.
- [ ] Claims in README and UI re-reviewed against this document.

---

## 6. Reporting a vulnerability

The program is deployed **on devnet only**, holds no user funds and is not
audited. Reports are accepted now, on that basis: no bug bounty, no committed
fix timeline.

- Open a **GitHub security advisory** on this repository, or email the
  maintainer privately. Never open a public issue for a security finding.
- Include the transaction signature or program address, and expected versus
  observed behaviour.
- A demonstration that a §3 row is graded too generously — that something marked
  ENFORCED survives deleting its mitigation — is as valuable here as an exploit.
  That is how §4.2 was found.

Before any deployment carries user funds, this section is replaced by a named
contact, a response-time commitment and a scope statement — a gate in §5.
