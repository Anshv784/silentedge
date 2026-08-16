# THREAT_MODEL.md

Companion to ARCHITECTURE.md. Assumes the design in that document, not the design in the
original brief.

**Status: PROPOSED, pre-implementation.** Every "Mitigated" below means *designed to be
mitigated*. Nothing is verified until the corresponding test exists and passes. Phase 18
converts this document into SECURITY_AUDIT.md with evidence.

---

## 1. Adversaries

| # | Adversary | Capability assumed |
|---|-----------|--------------------|
| A1 | **Platform operator (malicious or compromised)** | Full control of backend, database, frontend build pipeline, executor, RPC endpoints. Holds MXE authority and program upgrade authority unless removed. |
| A2 | **Single malicious Arx node** | Sees its own secret shares; can abort computations; can submit callback transactions. |
| A3 | **Colluding Arx nodes (n−1)** | All shares except one honest node's. |
| A4 | **All Arx nodes colluding** | Full plaintext access. Assumption broken by definition. |
| A5 | **MEV searcher / sandwicher** | Reads mempool and on-chain state; reorders and front-runs; can move DEX pool prices. |
| A6 | **Strategy-inference observer** | Reads all history; correlates Pyth prices with executed trades. No special access. |
| A7 | **Malicious user** | Crafts arbitrary transactions against our program; attacks other users' vaults. |
| A8 | **Compromised user endpoint** | Malicious browser extension, XSS, hostile RPC. |

---

## 2. Custody threats

| ID | Threat | Mitigation | Residual |
|----|--------|-----------|----------|
| **T-1** | Operator withdraws user funds | No instruction accepts an operator authority. `withdraw` requires `owner` signature and sends only to `owner` — destination is not a parameter. | None, given a correct program. This is the load-bearing invariant; test it adversarially. |
| **T-2** | Operator drains funds via a crafted "trade" | **Implemented.** See §2.1 — the route is untrusted by design; the program id is pinned and the vault's own balances are asserted across the CPI. | The route can still pick a bad-but-not-terrible fill inside the slippage band. Bounded, not eliminated. |
| **T-3** | Operator upgrades the program to add a backdoor | **Not mitigated at V1.** Upgrade authority initially held by the deployer. | **Open — Q3.** Must move to timelocked multisig before mainnet. Until then, "non-custodial" is true of the deployed code but not of future code. Disclose this. |
| **T-4** | Operator front-runs a withdrawal by pausing | `withdraw` is explicitly permitted while `Paused`. Pausing blocks new *trades* only. | None. Pausing must never trap funds — enforce in tests. |
| **T-5** | Malicious user drains another user's vault | All vault PDAs seeded by `owner`; Anchor `has_one` constraints on every account; ATA ownership asserted. | Standard Solana account-confusion risk. Requires disciplined constraint review. |
| **T-6** | Arithmetic overflow/underflow | `checked_*` everywhere; `overflow-checks = true` in release profile. | Low. |

### 2.1 Why the swap CPI is not an arbitrary CPI executor

`execute_trade` passes caller-supplied instruction data *and* a caller-supplied account
list to another program. Stated that way it is the most dangerous instruction in the
system, so it is worth being precise about what constrains it.

The route is **not** validated. We do not parse Jupiter's instruction data, and we do not
check which pools it touches — doing so would be a losing game against an aggregator whose
routes change constantly. Instead:

| | control |
|---|---|
| Program id | Pinned constant `JUP6Lkb…`, enforced as an account address constraint. Never read from instruction data. |
| Source ATA | Derived from `vault_config`; the ATA for the side being spent. |
| Destination ATA | Derived from `vault_config`. Not a parameter — there is nothing for a caller to point elsewhere. |
| Amount out | `oracle_min_out()`, computed on chain from Pyth and the vault's own `max_slippage_bps`. **Not caller-supplied.** |
| Signing | `invoke_signed` with the vault PDA seeds, and `is_signer` set for the vault PDA only. |

And then, after the CPI returns, three assertions on the vault's own state:

```
source_before - source_after == amount_in     // exactly the authorized amount left
dest_after - dest_before     >= min_out       // and the proceeds landed here
vault_config.lamports        unchanged        // rent is not a funding source
```

The security argument is therefore *not* "the route is safe". It is that **any** route
which fails to move exactly `amount_in` out of the vault's source ATA and at least
`min_out` into the vault's destination ATA reverts the whole transaction. A route that
tries to send proceeds elsewhere fails the second assertion. A route that spends more than
authorized fails the first.

The residual risk is real and worth naming: a route can fill *anywhere inside* the
slippage band and pocket the difference. `max_slippage_bps` is the entire defence there,
and it is the owner's setting. The floor being oracle-derived is what keeps that band
honest — an executor-supplied floor would make the band meaningless.

---

## 3. Strategy confidentiality threats

| ID | Threat | Mitigation | Residual |
|----|--------|-----------|----------|
| **T-7** | **Operator recovers strategies via `migrate-cluster`** | Investigated in depth. Fully operator-controlled clusters are a *documented supported feature* ("Invite only Arx nodes controlled by the organization"). There is **no CLI command to transfer, burn, or timelock the MXE authority**, and Recovery Peers have **no documented veto**. **Cluster pinning (ARCHITECTURE §7.1)** makes migration halt the system loudly and publicly. | **PARTIALLY MITIGATED.** Future strategies and all trade authorization are protected (T-37). **Strategy ciphertext already published on-chain remains decryptable** by an operator who migrates — inherent, since anything the MXE computes on, the MXE key decrypts, and on-chain data is permanent. Disclose explicitly. Gate mainnet on Q-A. |
| **T-8** | Backend sees plaintext strategy | Encryption is client-side in the browser; backend receives ciphertext only. Verified in Phase 6 by inspecting network requests, logs, DB, and transaction data. | Depends on frontend integrity — see T-15. |
| **T-9** | **Threshold inference from public trades** | Each evaluation yields a `(price, action)` pair and each pair is an inequality; enough of them squeeze every threshold between tight bounds. Partial mitigations: jittered cadence, randomised size (`ArcisRNG`), threshold *bands* rather than points. | **Inherent and unfixable.** Acting publicly reveals why you acted. Bounds tighten roughly logarithmically in the number of evaluations straddling a threshold — days, not years, for an active bot. Must be disclosed prominently. Full analysis: [`docs/what-is-private.md`](docs/what-is-private.md). |
| **T-38** | **`size_bps` is fully recoverable from a single trade** | `amount = vault_value × size_bps / 10_000`, and `vault_value` is public in the same transaction while `amount` is revealed. One non-HOLD evaluation discloses `size_bps` **exactly**. | **Not mitigated.** One of the four "secret" fields is not secret in practice. **Recommendation: move `size_bps` into public vault config before mainnet** — keeping it encrypted implies a protection that does not exist, which is worse than storing it in the clear. |
| **T-39** | **Trade size distinguishes a stop from a take-profit** | A stop exits the whole position (`amount == vault_value`); a take-profit trades the configured fraction. Both return `action = 2`, but the amounts differ, so an observer learns *which* sell rule fired — and therefore whether price sat below `stop_below` or above `exit_above`. | **Inherent** to "a stop is a full exit". Making them indistinguishable means sizing them identically, which changes what the product does. Feeds T-9: it converts one ambiguous observation into two precise ones. |
| **T-10** | Single node reads a strategy | Cerberus dishonest-majority: 1-of-n honest suffices for privacy. | Holds unless *all* nodes collude (A4). |
| **T-11** | All cluster nodes collude | None available in-protocol. | **Accepted risk.** Mitigation path: run our own Arx node in the cluster, per Arcium's own guidance, guaranteeing one honest participant. Recommended for V2 (**Q4**). |
| **T-12** | Timing side channel reveals which branch fired | Arcis executes both branches of every non-constant conditional (RESEARCH §2.7) — the circuit is fixed-shape and data-independent by construction. | Low, and it comes free from the MPC model. |
| **T-13** | Operator silently swaps a user's strategy | `submit_strategy` requires the owner's signature. Updates bump `strategy_version`, invalidating in-flight intents. | None, given correct constraints. |
| **T-14** | Strategy replay — reactivating an old strategy | Intents bind `strategy_version`; stale versions rejected. | Low. |

---

## 4. Frontend and client threats

| ID | Threat | Mitigation | Residual |
|----|--------|-----------|----------|
| **T-15** | Malicious frontend exfiltrates plaintext before encryption | The frontend is a genuine trust boundary here: it *sees* plaintext by necessity. Mitigations: strict CSP, SRI, no third-party scripts on the builder page, reproducible builds, published hashes, open source. | **Real and unavoidable.** A user who does not trust the served frontend must self-host. Disclose. |
| **T-16** | Hostile RPC feeds fake state | Wallet-signed transactions cannot be forged by an RPC; the worst case is display deception and censorship. User-configurable RPC. | Display integrity depends on the RPC. |
| **T-17** | XSS | React default escaping, no `dangerouslySetInnerHTML`, CSP, dependency audit. | Standard web risk. |
| **T-18** | Malicious wallet | Out of scope — user's trust choice. | Accepted. |

---

## 5. Arcium operational threats

| ID | Threat | Behaviour | Residual |
|----|--------|-----------|----------|
| **T-19** | One node aborts computations (DoS) | Cerberus is detect-and-abort; any node can abort. System fails closed: no intent → no trade. | **Liveness only.** Strategies silently stop firing. Needs monitoring and user-visible "last successful evaluation" so silence is never mistaken for HOLD. |
| **T-20** | Forged callback | `verify_output()` checks the cluster's aggregate BLS signature and binds to `computation_account`. Our program trusts *only* this — never the callback transaction's Solana signer, which is an ordinary per-node keypair. | Rests on BLS soundness and correct cluster key registration. |
| **T-21** | Computation expires unfinalized | Expires after 180 slots (~72 s); fee reclaimable. | Liveness. Reclaim fees; surface to user. |
| **T-22** | Cluster unavailable | No evaluations. Withdrawals unaffected. | Acceptable — the safe failure direction. |
| **T-23** | Callback exceeds 1,232 bytes (`OutputTooLarge`) | Output is deliberately tiny: `(action: u8, amount: u64)`. | Low, by design. |

---

## 6. Trading and market threats

| ID | Threat | Mitigation | Residual |
|----|--------|-----------|----------|
| **T-24** | Stale oracle triggers a bad trade | `get_price_no_older_than()` with an explicit threshold, checked **on-chain** at both evaluation and execution. | Low. |
| **T-25** | Wide confidence interval (illiquid/volatile) | Reject trade when `conf/price > max_conf_bps`. Pyth's guidance is to widen spreads; we refuse outright — simpler and safer. | Low. |
| **T-26** | **DEX price manipulation to trigger a stop** | This is why Pyth, not a DEX quote, is the trigger. Moving a pool does not move the Pyth aggregate. | Substantially mitigated by oracle choice. Would be a critical flaw had we used Jupiter quotes as the trigger. |
| **T-27** | Sandwich attack on our swap | On-chain `min_amount_out` derived from Pyth at execution time and asserted after the CPI, bounded by `max_slippage_bps`; optional `tx.jup.ag` submission with tip. There is **no** separate post-swap deviation-band check — this row claimed one for a while and none existed. | **Partially mitigated.** `TradeIntent` is public before execution, so intent is visible. Short expiry windows reduce but do not eliminate exposure. Do not claim front-running resistance. |
| **T-28** | Intent visible between callback and execution | Short `expires_at_slot`; permissionless execution lets anyone (including the user) close the window fast. | Inherent to splitting decision from execution — which the 1,232-byte callback limit forces. |
| **T-29** | Liquidity disappears / route fails | Swap reverts atomically; intent stays unconsumed until expiry. | Low. |
| **T-30** | Rapid price movement between decision and execution | `min_amount_out` fixed at intent creation; slot expiry bounds staleness. | Trade simply fails — correct direction. |
| **T-31** | Repeated triggering drains value via fees/slippage | `cooldown_seconds`, enforced on entries in `execute_trade`. Owner can pause. **`daily_loss_limit_bps` is stored and NOT enforced** — see state.rs for why realised P&L is not measurable here without putting the oracle on the withdraw path. | **Partial.** A cooldown bounds the rate, not the total. Exits are deliberately exempt so a de-risking sell is never throttled, which also means churn via repeated sells is not rate-limited. |

---

## 7. Authorization threats

| ID | Threat | Mitigation |
|----|--------|-----------|
| **T-32** | Replay of an old trade action | Four layers: `consumed` flag, `vault_nonce` equality, `strategy_version` binding, slot expiry. |
| **T-33** | Fake/spoofed computation result | BLS `verify_output()` against cluster account. |
| **T-34** | Unauthorized signer submits a trade | Executor is intentionally permissionless and holds no privilege; every parameter is already fixed in `TradeIntent` and every rule is checked on-chain. There is no signer to compromise. |
| **T-35** | Trade exceeding limits | `max_trade_bps` and `cooldown_seconds`, checked in `execute_trade` against on-chain state rather than callback data — **on entries only**. Exits are uncapped and unthrottled on purpose: the cap can never exceed 50%, so applying it to a full-position stop rejected every stop-loss, and a sell's value is already bounded by the oracle-derived `min_out`. Daily loss is not enforced. |
| **T-36** | Arbitrary CPI / arbitrary program execution | Swap program ID is a **pinned constant**, never read from instruction data. Mint allowlist enforced. No generic CPI executor exists anywhere in the program. |
| **T-37** | **Operator forges trade authorizations via a migrated cluster** — *new, and the most serious finding of this pass* | Arcium's generated constraint derives `cluster_account` from `mxe_account`, so it silently follows a migration; `verify_output()` then validates BLS against *that* cluster. An operator who migrated to a cluster they control could mint attestations our program accepts as genuine MPC results. **Mitigation: pin `cluster_account` to a compiled-in constant** (ARCHITECTURE §7.1). Changing it requires a program upgrade, which the timelocked multisig makes public and delayed. | **Mitigated**, and it must stay mitigated — this constraint is load-bearing for custody, not just privacy. Any refactor touching it requires review. |

---

## 8. Ranked open risks

1. **T-7 — historical strategy ciphertext is recoverable by the MXE authority.** Cannot be
   fixed with current Arcium features. Cluster pinning stops everything except retroactive
   decryption of already-published ciphertext. **Must be disclosed, not claimed away.**
2. **T-9 — Threshold inference from public trade history.** Unfixable; disclose prominently. Sharpened by T-38 and T-39, which turn ambiguous observations into precise ones.
2b. **T-38 — `size_bps` recoverable from one trade.** Move it to public config; do not claim it is secret.
3. **T-37 — Forged attestation via migrated cluster.** Mitigated by cluster pinning, but the
   constraint is load-bearing for custody and must never be relaxed.
4. **T-3 — Program upgrade authority.** Must be a timelocked multisig before mainnet.
5. **T-15 — Frontend sees plaintext by necessity.** Mitigable, never eliminable when hosted.
6. **T-27 — Public intent window enables sandwiching.** Forced by the callback size limit.
7. **T-19 — Any single node can abort.** Liveness only; needs monitoring so silence is never
   mistaken for HOLD.

### 8.1 Emergency withdrawal — verified independent of Arcium

`withdraw` takes: `VaultConfig`, the vault's two PDA-owned ATAs, the owner's ATA, the owner as
signer, and the SPL Token program. It touches **no Arcium account** — not the MXE, not the
cluster, not a computation account — and **no MagicBlock account**.

Therefore withdrawal continues to work if: the Arcium cluster halts, all Arx nodes go offline,
the MXE is closed or migrated, cluster pinning rejects every evaluation, the operator's backend
and executor disappear, or Jupiter is unavailable. The only requirements are that Solana is
live and the user can sign.

`pause` blocks new trades but explicitly does **not** block `withdraw`. Pausing must never trap
funds. Both properties are test obligations, not aspirations — see §9.

---

## 9. Test obligations

Every row below must have a passing test before the corresponding phase is called done.
Negative tests (asserting rejection) matter more than positive ones here.

**Custody:** operator withdrawal attempt → rejected · withdrawal to non-owner → rejected ·
withdrawal while paused → **succeeds** · cross-vault account substitution → rejected ·
non-allowlisted mint → rejected · overflow/underflow → rejected.

**Authorization:** forged callback → rejected · replayed intent → rejected · expired intent →
rejected · stale `strategy_version` → rejected · oversized *entry* → rejected · cooldown
violation on an *entry* → rejected · non-Jupiter swap program → rejected · swap output to a
non-vault ATA → rejected · full-position exit → **allowed**, uncapped and unthrottled.

**Oracle:** stale price → rejected · wide confidence → rejected · missing account → rejected ·
fill below the oracle-derived floor → rejected.

`max_oracle_deviation_bps` is stored and unread. A decision-price-versus-execution-price band
would fire essentially never inside a ~72-slot intent window, and the price it would compare
against is chosen by whoever queues the evaluation. The oracle-derived `min_out`, recomputed
at execution time, is the check that actually does this job.

**Confidentiality:** plaintext strategy absent from network requests, server logs, database,
and transaction data (Phase 6) · action-only reveal confirmed in callback data · no threshold
present in the evaluation transaction's **serialized message bytes**, not merely absent from
its JSON rendering — instruction data is base58 there, so searching the JSON passes vacuously
whether or not the secret is present.

**Liveness:** cluster abort → no intent, no trade, no default action · expired computation →
fee reclaimed · executor absent → user can self-execute.

**Cluster pinning (T-37, T-7):** `cluster_account` ≠ `EXPECTED_CLUSTER` → `evaluate_strategy`
**rejected** · same for `evaluate_callback` → **rejected** · attestation from a non-pinned
cluster → **rejected** · `withdraw` while cluster pinning is failing → **succeeds**.

**Emergency withdrawal (§8.1):** withdraw with Arcium unreachable → succeeds · withdraw with MXE
closed → succeeds · withdraw with executor offline → succeeds · withdraw while paused →
succeeds · assert no Arcium or MagicBlock account appears in the `withdraw` account list.
