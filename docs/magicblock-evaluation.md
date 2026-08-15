# MagicBlock Evaluation

Focused re-research of MagicBlock against the specific question: **can an Ephemeral Rollup
accelerate the parts of the system we control?** Conducted 2026-08-15 against
`https://docs.magicblock.gg/llms-full.txt` (516 KB, retrieved same day).

This supersedes the brief §3 treatment in RESEARCH.md, which only established that a Jupiter
swap cannot run inside an ER. That was necessary but not sufficient — the real question is
whether our *own* accounts benefit.

**Verdict: No integration point exists on the critical path. Recommend excluding MagicBlock
from V1 and V2. Jupiter stays.** The reasoning is structural, not marginal — see §3.

> **Re-confirmed 2026-08-15** after the T-7 authority investigation. That work added a
> mandatory **cluster-pinning** constraint (ARCHITECTURE §7.1) on `evaluate_strategy` and
> `evaluate_callback`. This *strengthens* the case against delegation: those instructions now
> carry a custody-critical constraint that must be evaluated on L1 against live Arcium state,
> making the accounts involved even less eligible for delegation. No change to the verdict.

---

## 1. What can and cannot be delegated — verified

| Item | Delegatable? | Source |
|------|-------------|--------|
| Our program's own PDAs | **Yes** | "Delegation is the process of transferring ownership of one or more of your program's PDAs to the delegation program." |
| Program accounts | **No** | "Program accounts are never delegated... program accounts are cloned." |
| Accounts owned by third-party programs (Jupiter, Raydium, Orca, Pyth, Arcium) | **No** | Delegation transfers ownership; we cannot transfer ownership of accounts we do not own. |
| Accounts not already existing on L1 | **No** | "Delegated account must exist on Solana beforehand." |
| SPL token accounts | Only via the **Ephemeral SPL Token** (eATA) lifecycle, a distinct custody model | §4 |

Reading on L1 state from inside an ER is unrestricted: "Every account on Solana is readable
on ER, while only delegated account can be changed on ER."

So in principle we *could* delegate `VaultConfig`, `TradeIntent`, position state, and cooldown
state — they are our PDAs. The question is what happens when we do.

## 2. The blocking mechanic

This is the fact that decides the entire evaluation:

> "`Delegation` is the process of **transferring ownership** of one or more of your program's
> `PDAs` to the delegation program."
>
> "`Commit` is the process of updating the state of the `PDAs` from ER to the base layer.
> After the finalization process, the PDAs **remain locked on base layer**."
>
> "`Undelegation` ... Once state is validated, the `PDAs` are **unlocked and can be used as
> normal on base layer**."

**While an account is delegated, it is owned by the Delegation Program and locked on L1. Our
program cannot write to it on L1.**

That is not a performance caveat. It is a hard exclusion, and it collides with two
non-negotiable L1 writes in our design.

## 3. Why nothing on the critical path can be delegated

Our pipeline, with the mandatory-L1 reason for each stage:

| # | Stage | Must be L1 because | Delegatable? |
|---|-------|-------------------|--------------|
| 1 | `evaluate_strategy` → `queue_computation` | CPIs the **Arcium program** and writes Arcium's mempool/computation accounts. Those are Arcium-owned; we cannot delegate them. | **No** |
| 2 | Arcium MPC execution | Runs off-chain in the Arx cluster. Not a Solana account operation at all. | **N/A** |
| 3 | BLS callback → writes `TradeIntent` | The callback is an **L1 transaction** submitted by an Arx node. If `TradeIntent` were delegated, it would be locked on L1 and **the callback would fail**. | **No** |
| 4 | Jupiter quote (`/build`) | Off-chain HTTP. | **N/A** |
| 5 | `execute_trade` → Jupiter CPI | Mutates DEX pool accounts (not ours) **and** writes `TradeIntent.consumed`, `vault.nonce`, cooldown, daily-loss counters. Delegating any of those locks them on L1 and **the swap fails**. | **No** |

Point 3 deserves emphasis because it is counter-intuitive and fatal: **delegating the vault's
intent or config state would break the Arcium authorization path outright.** The BLS-attested
callback is an ordinary L1 transaction. Locked accounts are unwritable by it. Delegation and
Arcium-attested authorization are mutually exclusive over the same accounts.

So every account on the critical path must remain undelegated. There is no ER-resident state
on that path, and therefore **no latency for the ER to remove from it**. This conclusion does
not depend on any measurement — no benchmark can change it, which is why §6 recommends not
spending the build effort to run one against a non-existent integration point.

## 4. Analysis of each proposed integration point

Applying the full checklist to all seven candidates.

### 4.1 Summary

| # | Candidate | Delegatable | On critical path | Latency gain | Verdict |
|---|-----------|-------------|------------------|--------------|---------|
| 1 | Fast vault/bot state updates | Yes | **Yes** — written by callback + `execute_trade` | Negative (breaks both) | **Reject** |
| 2 | Position state | Yes | **Yes** — derived from vault ATA balances at swap time | None | **Reject** |
| 3 | Execution state (`TradeIntent`) | Yes | **Yes** — written by BLS callback | Negative (breaks callback) | **Reject** |
| 4 | Cooldown / state transitions | Yes | **Yes** — enforced in `execute_trade` on L1 | Negative (breaks enforcement) | **Reject** |
| 5 | Post-Arcium execution coordination | Yes | **Yes** | Negative | **Reject** |
| 6 | High-frequency evaluation state | Yes | Partly | ~0 (MPC-bound) | **Reject** |
| 7 | Other user-owned accounts (analytics, history) | Yes | **No** | None on trade path | **Reject** — cost without benefit |

### 4.2 Detail on the two that look most promising

**Candidate 6 — high-frequency evaluation state.** The strongest-sounding case: if the bot
evaluates often, move the evaluation counter/heartbeat into the ER at 10 ms slots instead of
400 ms.

- *What is delegated?* An evaluation-bookkeeping PDA (last-eval slot, counter).
- *Who controls it?* Our program, then the Delegation Program while delegated.
- *Contains user funds?* No.
- *Safe to delegate?* Yes, in isolation.
- *Latency gain?* **Effectively zero.** Each evaluation still requires an L1
  `queue_computation` CPI into the Arcium program (stage 1), which cannot be delegated, and
  then waits on MPC. Speeding up a side counter while the actual evaluation is L1-and-MPC
  bound saves nothing. Worse, the ER-side counter and the L1-side Arcium queue would be two
  sources of truth for "have we evaluated recently", and the enforcement copy has to be the
  L1 one anyway.
- *Verdict:* **Reject.** Optimises a non-bottleneck and adds a state-divergence bug class.

**Candidate 7 — non-critical accounts (analytics, trade history, PnL display).** Genuinely
delegatable and genuinely safe — these hold no funds and gate nothing.

- *Latency gain on the trade path?* **Zero by construction** — that is what makes them safe.
- *Cost?* A second RPC connection, delegation lifecycle code, commit scheduling, an extra
  liveness dependency for the dashboard, and a new failure mode where displayed state diverges
  from settled state.
- *Verdict:* **Reject for V1/V2.** This is the only technically sound integration available,
  and its entire benefit is a faster-updating dashboard. That does not justify the operational
  surface, and it would let us say "powered by MagicBlock" while gaining nothing on the metric
  that matters. That is precisely the marketing-driven integration the brief prohibits.

### 4.3 The checklist, answered for the delegate-vault-state family (candidates 1–5)

| Question | Answer |
|----------|--------|
| What account is delegated? | `VaultConfig`, `TradeIntent`, position/cooldown PDAs |
| Who controls the account? | Our program → **Delegation Program** while delegated |
| Contains user funds? | Not directly, but **gates** every movement of them |
| Can it safely be delegated? | **No** — locks the account against the BLS callback and against `execute_trade` |
| If MagicBlock goes offline? | Accounts stay locked on L1. Undelegation is initiated **on the ER** and finalised on L1 "through validator CPI" — it **requires the ER validator to act**. No user-initiated force-undelegation escape hatch is documented. |
| How does state return to Solana? | Commit (stays locked) or commit-and-undelegate (unlocks after fraud-proof finalisation) |
| New trust assumption? | **Yes** — the ER validator plus the fraud-proof "decentralized Security Committee" |
| Reduces latency? | **No** — it breaks the path entirely |
| Affects non-custodial model? | **Yes, severely** — trade enforcement and pause/withdraw gating would depend on ER liveness |
| Affects Arcium's model? | **Yes** — the BLS callback could not write its result |
| Exploitable? | State divergence between ER and L1 during commit windows becomes a new attack surface against risk limits |
| Can the user still withdraw if MagicBlock fails? | **Not reliably** — this alone disqualifies it |

That last row is decisive on its own. The brief's core requirement is that a user can always
get their funds out. Any design where withdrawal depends on a third-party validator's liveness
fails that requirement regardless of its latency properties.

## 5. Steelman: ER-native custody (eATA), rejected on its merits

The strongest version of the MagicBlock case is not partial delegation — it is adopting
MagicBlock's **own** recommended trading architecture. Their prediction-markets/leveraged-trading
guide puts the entire latency-sensitive loop inside the ER: positions and orders delegated,
collateral in program-controlled **eATA** custody, oracle read inside ER instructions, cranks
for liquidation, and **Magic Actions** to fire a base-layer instruction immediately after a
commit.

Magic Actions are real and would be the bridge: "attach one or more call instructions that run
automatically on the Solana base layer immediately after an Ephemeral Rollup commit."

It still fails, for three independent reasons:

1. **It does not fit our product.** Their model is a *self-contained internal market* — the ER
   is the venue, and custody is internal. We must execute on an **external** DEX via Jupiter on
   L1. Their own docs concede the consequence for our custody model: base-layer custody +
   post-commit payout means "**Token movement waits for commit**." So the ER *adds* a commit
   round-trip before a swap can occur. That is added latency, not saved latency.

2. **It breaks custody.** eATA custody puts user funds under the ephemeral validator and the
   fraud-proof committee. Withdrawal liveness would depend on them. The brief's requirement —
   the user can always withdraw, the operator holds no unilateral key — would no longer hold in
   the same clean form.

3. **Magic Actions cannot carry a Jupiter swap well.** The handler is an L1 instruction subject
   to "Standard Solana limits... (compute, account locks)", with all accounts pre-declared via
   `ShortAccountMeta`, and as a CPI it forfeits ALTs. A Jupiter route's account set is
   determined at quote time, not at ER-commit time. Baking a route into a commit-time handler
   is fragile, and "any action failure reverts the commit" turns a routine swap failure
   (slippage, liquidity) into a rolled-back commit.

Adopting the ER-native model would mean replacing Jupiter with an internal venue. The brief
explicitly forbids that, and it would be the wrong call anyway — Jupiter's routing is the
product's actual execution quality.

## 6. Benchmark

The brief asks for a benchmark before integrating. Two honest statements:

**First, the benchmark cannot be run yet.** Measuring the pipeline requires a deployed Arcium
MXE (Phase 7 minimum) and a deployed vault program. There is nothing to measure today, and
publishing invented numbers would be worse than publishing none.

**Second, for the critical path the benchmark is already moot.** §3 shows there is no candidate
integration point — every account on the path must stay undelegated. A benchmark compares two
implementations; Option B does not exist as a buildable variant without breaking the Arcium
callback or the swap. Measuring is not the way to settle this; the account model already settles it.

What the benchmark *is* still needed for — and what Phase 13 should actually do — is measuring
the pipeline itself, because the dominant term is unknown and shapes the product:

| Stage | Instrument | Expected |
|-------|-----------|----------|
| `evaluate_strategy` submit → confirm | client timestamps | ~400–800 ms |
| **Arcium queue → callback finalization** | `awaitComputationFinalization` | **unknown — the whole question** |
| Callback confirm → intent readable | RPC poll | ~400 ms |
| Jupiter `/build` round trip | HTTP timing | ~100–300 ms |
| `execute_trade` submit → confirm | client timestamps | ~400–800 ms |

Report p50, p95, worst case, and failure rate (aborts, expiries, slippage rejections) over
≥100 runs on devnet. Known reference points: Solana slot ~400 ms, ER slot ~10 ms, Arcium queue
TTL 180 slots (~72 s), TS client default timeout 120 s.

Decision rule, fixed in advance: **if MPC latency dominates — which the 72 s TTL and 120 s
default strongly suggest — then even a hypothetical zero-latency L1 layer would not
meaningfully change end-to-end time.** Shaving 400 ms off a multi-second MPC-bound pipeline is
noise. Against the stated goal of *seconds-level automated trading, not HFT*, the L1 legs are
already comfortably inside budget.

## 7. Recommendation

**Do not integrate MagicBlock in V1 or V2.** Keep Jupiter. Keep the architecture in
ARCHITECTURE.md unchanged.

Reasoning, in order of strength:

1. **Structural:** delegated accounts are locked on L1; the BLS callback and the swap are both
   L1 writes to exactly those accounts. There is no critical-path integration point.
2. **Custody:** every variant that touches funds or gating makes withdrawal depend on ER
   validator liveness, violating the core non-custodial requirement.
3. **Latency:** the bottleneck is Arcium MPC, which MagicBlock cannot touch. The L1 legs are
   already within a seconds-level budget.
4. **Fit:** MagicBlock's own trading architecture assumes an internal venue. Ours is external
   by design.

The only sound integration (non-critical display state) delivers no trade-path benefit and
would exist mainly to justify the logo. That is the outcome the brief explicitly warns against.

### When to revisit

Revisit if any of these becomes true:

- The product adds an **internal matching engine** or internal orderbook, making our own order
  state the hot path. MagicBlock is genuinely strong for that — it is what their stack is built for.
- Arcium latency benchmarks come back **sub-second**, making the L1 legs the dominant term.
  Only then does ~400 ms matter, and only for state we can legally delegate.
- MagicBlock documents a **user-initiated force-undelegation** escape hatch that removes the
  withdrawal-liveness dependency.

### One item worth tracking separately

**Private Ephemeral Rollups (PERs)** are TEE-backed and offer "restricted position or strategy
visibility". This is a *confidentiality* mechanism, not a latency one, and is a possible
alternative or complement to Arcium. Its trust model is fundamentally different — hardware
attestation versus dishonest-majority MPC — and generally considered weaker for this threat
model. Not evaluated here; not proposed. Flagging it only so the choice is recorded as
deliberate rather than overlooked.

## 8. Sources

- [Delegation, Commitment & Undelegation](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup)
- [Ephemeral Rollups FAQ](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/faq)
- [Runtime Limits](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/runtime-limits)
- [Magic Actions overview](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/magic-actions/overview)
- [Magic Actions troubleshooting](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/magic-actions/troubleshooting)
- [Prediction Markets & Trading architecture](https://docs.magicblock.gg/pages/solutions/prediction-markets)
- [Ephemeral SPL Token overview](https://docs.magicblock.gg/pages/ephemeral-spl-token/overview)
- [Ephemeral Rollups whitepaper](https://arxiv.org/abs/2311.02650)
