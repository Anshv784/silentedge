# ARCHITECTURE.md

Derived from RESEARCH.md. Read that first — this document assumes findings F1–F3.

**Status: PROPOSED. Not approved. No implementation has begun.**

---

## 1. The core decision

The brief proposed:

```
Private strategy → Arcium MPC → BUY/SELL → MXESigningKey threshold signing → Solana vault
```

`MXESigningKey` cannot fill that role (RESEARCH F1: `ArcisEd25519` is SHA3-512-based and
therefore not a valid Solana signature scheme). The brief anticipated this and asked for a
"weaker fallback" — a Squads multisig with a restricted authorization path.

**We do not need the weaker fallback.** Arcium already provides on-chain, cluster-attested
threshold authorization through the BLS-signed callback (`verify_output()`). The correct
design uses it directly:

```
Private strategy  →  Arcium MPC  →  BLS-attested callback  →  on-chain TradeIntent
                                                                     │
                                          program-enforced rules ────┤
                                                                     ▼
                                              permissionless executor submits swap
                                                                     ▼
                                            Vault PDA CPIs Jupiter (invoke_signed)
```

This is **stronger** than the original proposal, and worth being precise about why. A
signing key that can sign arbitrary transactions is a bearer credential: whoever induces a
signature controls the funds, and the vault's safety rests on the circuit author never
making a mistake about what gets signed. Our design inverts that. The MPC layer produces
only a *claim* ("the strategy says BUY, size 100 USDC"), and the Solana program independently
enforces every rule about what may be done with that claim. Compromising the MPC layer
completely still does not let an attacker withdraw funds — the withdrawal instruction
does not accept an MPC-derived authority at all.

**Custody rule, stated once and enforced everywhere:**

> Funds leave a vault by exactly two paths: (a) a swap between two allowlisted mints,
> where both sides stay inside the same vault; (b) a withdrawal to the vault owner's
> wallet, signed by the owner. There is no third path, and no instruction accepts an
> operator key.

---

## 2. Component responsibilities

| Layer | Owns | Explicitly does NOT own |
|-------|------|------------------------|
| **Solana program (`vault`)** | Custody, limits, allowlists, intent lifecycle, swap CPI, all enforcement | Strategy contents |
| **Arcium MXE (Arcis circuits)** | Encrypted strategy state, private evaluation, action decision | Funds, signing authority over funds |
| **Jupiter (Router `/build`)** | Route discovery, swap execution | Trigger prices, authorization |
| **Pyth** | Trigger price + on-chain sanity band | Execution pricing |
| **Frontend (Next.js/TS)** | Strategy authoring, client-side encryption, wallet signing | Plaintext strategy custody after encryption |
| **Backend (`api`)** | Scheduling, RPC relay, indexing, UX data | Keys, plaintext strategies, authority of any kind |
| **Executor** | Submitting swap transactions | Choosing what to trade |

The backend is **untrusted by design**. It holds no key that can move funds, cannot read a
plaintext strategy, and cannot fabricate a trade. Its worst-case compromise is censorship
(refusing to schedule evaluations) — a liveness failure, never a safety failure.

---

## 3. Account model

```
VaultConfig  PDA  seeds = ["vault", owner]
  owner: Pubkey                 // only withdrawal destination, ever
  strategy_state: Pubkey        // -> StrategyState
  base_mint / quote_mint        // allowlisted pair, immutable after init
  base_ata / quote_ata          // PDA-owned token accounts
  limits: RiskLimits
  status: Active | Paused | Stopped
  nonce: u64                    // monotonic; replay protection
  day_epoch: i64, day_start_value: u64, realized_loss_today: u64
  last_trade_ts: i64            // cooldown
  bump: u8

StrategyState  PDA  seeds = ["strategy", vault]
  ciphertexts: [[u8; 32]; N]    // Enc<Mxe, Strategy>
  nonce: u128                   // Arcium encryption nonce
  version: u32                  // bumped on update; binds intents
  lifecycle: Draft|Active|Paused|Stopped

TradeIntent  PDA  seeds = ["intent", vault]     // singleton per vault
  side: Buy | Sell
  amount_in: u64
  min_amount_out: u64
  expires_at_slot: u64
  vault_nonce: u64              // must equal VaultConfig.nonce
  strategy_version: u32
  consumed: bool

RiskLimits
  max_trade_bps            // e.g. 1000 = 10% of vault per trade
  max_slippage_bps         // e.g. 50 = 0.5%
  daily_loss_limit_bps     // e.g. 500 = 5%
  cooldown_seconds
  max_oracle_staleness_sec
  max_conf_bps             // reject if Pyth conf/price exceeds this
  max_oracle_deviation_bps // execution vs Pyth band
```

`TradeIntent` is a singleton per vault. A new intent overwrites any unconsumed one. This
makes queue-stuffing impossible and keeps replay reasoning simple.

---

## 4. Money flow

```
User wallet ──deposit(USDC)──► Vault quote_ata (PDA-owned)
                                     │
                                     │ swap, both legs stay in-vault
                                     ▼
                              Vault base_ata (SOL)
                                     │
User wallet ◄──withdraw()───────────┘
   ▲
   └── signed by owner ONLY. No operator instruction exists.
```

Enforced invariants:
- `withdraw` requires `owner` as signer and sends **only** to `owner`. The destination is
  not a parameter.
- `execute_trade` may move tokens only between `base_ata` and `quote_ata` of the *same*
  vault, both PDA-owned. Post-swap balance assertions confirm this.
- No instruction transfers to any operator-controlled address. This is a property of the
  instruction set, not of a runtime check.
- `pause` may be called by owner **or** by a guardian (circuit breaker). `withdraw`
  remains available while paused — pausing must never trap user funds.

---

## 5. Strategy flow

```
Strategy Builder (browser)
   │  { entry_below, exit_above, stop_below, size_bps }
   ▼
Normalize → fixed-size struct, i64 fixed-point
   ▼
Client-side encrypt  (x25519 ECDH + RescueCipher, @arcium-hq/client)
   │  plaintext never leaves the browser
   ▼
submit_strategy(ciphertexts, nonce)   ── user-signed Solana tx
   ▼
StrategyState { Enc<Mxe, Strategy> }
```

The backend receives ciphertext only. Phase 6 must prove this by inspection of network
requests, server logs, database rows, and transaction data.

**Lifecycle:** `Draft → Active → Paused → Stopped`, plus updates. A strategy update is a
new encryption submitted by the owner; it bumps `strategy_version`, which invalidates any
in-flight `TradeIntent`. The operator has no instruction that can modify `StrategyState` —
mutation requires the owner's signature.

---

## 6. Arcium flow

```
Scheduler (permissionless — backend, keeper, or the user)
   │
   ▼
evaluate_strategy(vault)                     [Solana tx]
   │  reads Pyth → price, conf, publish_time
   │  rejects stale / wide-confidence / paused
   │  queue_computation(args) ──CPI──► Arcium program
   ▼
Arcium cluster (Cerberus MPC, dishonest-majority)
   │  inputs: Enc<Mxe, Strategy>  +  public price
   │  both branches always execute — no timing side channel
   ▼
callback ──► our program's evaluate_callback
   │  output.verify_output(cluster_account, computation_account)   ← BLS threshold sig
   ▼
write TradeIntent  (or write nothing, if HOLD)
```

Circuit, in shape (exact syntax per current Arcis at implementation time):

```rust
#[instruction]
pub fn evaluate(
    strategy_ctxt: Enc<Mxe, Strategy>,   // persistent, MXE-only
    price: u64,                          // public, from Pyth
    vault_value: u64,                    // public
) -> (u8, u64) {                         // (action, amount_in) — revealed
    let s = strategy_ctxt.to_arcis();

    // Branchless: every comparison is always evaluated.
    let buy  = price < s.entry_below;
    let sell = (price > s.exit_above) | (price < s.stop_below);

    let action = if sell { 2u8 } else if buy { 1u8 } else { 0u8 };
    let amount = (vault_value * s.size_bps) / 10_000;
    let amount = if action == 0 { 0 } else { amount };

    (action.reveal(), amount.reveal())
}
```

Two deliberate properties:

1. **Only the action is revealed.** Thresholds stay inside `Enc<Mxe, Strategy>` and are
   never output.
2. **No data-dependent control flow.** Arcis executes both branches regardless
   (RESEARCH §2.7), so execution time cannot leak which condition fired. We rely on this
   rather than fighting it.

**Liveness.** Cerberus is detect-and-abort: any single faulty node can abort. HOLD and
"aborted" are therefore indistinguishable to an outside observer, and both are normal.
The system must **fail closed** — no intent written means no trade. It must never infer a
default action from a missing result.

---

## 7. Authorization and signing flow

This replaces the brief's `MXESigningKey` flow.

```
                    Arcium cluster
                          │
            BLS threshold signature over output
                          │
                          ▼
        our program: output.verify_output(...)      ← the trust boundary
                          │
                  ┌───────┴────────┐
              Ok(result)        Err(_)
                  │                │
                  ▼                ▼
          write TradeIntent    abort, no state change
                  │
                  ▼
   ┌──────────────────────────────────────────┐
   │  execute_trade  — callable by ANYONE     │
   │  ── verifies against on-chain state ──   │
   │  1. vault Active, not paused             │
   │  2. intent.consumed == false             │
   │  3. intent.vault_nonce == vault.nonce    │
   │  4. intent.strategy_version current      │
   │  5. current_slot <= expires_at_slot      │
   │  6. amount_in <= max_trade_bps of vault  │
   │  7. cooldown elapsed                     │
   │  8. daily loss limit not breached        │
   │  9. Pyth fresh + confidence within band  │
   │ 10. swap program ∈ allowlist {Jupiter}   │
   │ 11. mints ∈ allowlist {USDC, SOL}        │
   │ 12. destination ATA == vault's own ATA   │
   └──────────────────┬───────────────────────┘
                      ▼
      CPI Jupiter route, invoke_signed(vault PDA seeds)
                      ▼
      post-swap assertions: actual_out >= min_amount_out
                           balances landed in vault ATAs
                           realised price within Pyth deviation band
                      ▼
      intent.consumed = true;  vault.nonce += 1;  emit TradeExecuted
```

Why the executor is permissionless: it holds no privilege. Every parameter of the trade is
already fixed in `TradeIntent` and every rule is checked on-chain. The executor chooses
only *whether* and *when* (within the expiry window) to submit. That is a liveness role, not
a trust role — the user can always run their own. If the operator's executor vanishes,
users are not stuck: they can self-execute or withdraw.

**Replay protection** is layered deliberately: `consumed` flag, `vault_nonce` equality,
`strategy_version` binding, and slot expiry. Any one would mostly work; together they fail
safe if one is buggy.

### 7.1 Cluster pinning — mandatory

Arcium's generated constraint derives the cluster account from the MXE account:

```rust
#[account(address = derive_cluster_pda!(mxe_account))]   // follows migration silently
pub cluster_account: Box<Account<'info, Cluster>>,
```

`verify_output()` validates the BLS signature **against whatever cluster account is passed**.
Left as generated, an operator who migrates the MXE to a cluster they control could mint BLS
attestations our program would accept as genuine MPC results — forging trade authorizations.

**We therefore pin the cluster to a per-network constant** in both `evaluate_strategy` and
`evaluate_callback`:

```rust
#[account(
    address = derive_cluster_pda!(mxe_account),
    constraint = cluster_account.key() == EXPECTED_CLUSTER @ VaultError::UnexpectedCluster,
)]
pub cluster_account: Box<Account<'info, Cluster>>,
```

`EXPECTED_CLUSTER` is the cluster PDA for offset `456` (devnet) / `2026` (mainnet), compiled in.
Changing it requires a program upgrade — which, once the upgrade authority is a timelocked
multisig (§9), is itself public and delayed.

This single constraint does three jobs:

1. **Closes the forgery path.** Only the pinned cluster's aggregate BLS key can authorize a trade.
2. **Makes migration loud.** Post-migration, `evaluate_strategy` and `evaluate_callback` both
   fail. The bot halts visibly instead of continuing under an operator-controlled cluster.
3. **Preserves withdrawals.** `withdraw` touches none of these accounts, so users are unaffected.

It does **not** protect strategy ciphertext already published on-chain — see §9 assumption 4.

---

## 8. What is public vs private

### Public (on-chain, unavoidable)
- Vault existence, owner address, token balances
- Every trade: side, amount in, amount out, timestamp, route
- Every evaluation: that one occurred, and the Pyth price used
- `TradeIntent` contents during the window between callback and execution
- Strategy *ciphertext* and the fact a strategy exists
- Computation queue/finalization events and fees paid

### Private (under Arcium's 1-of-n honest assumption)
- `entry_below`, `exit_above`, `stop_below`, `size_bps`
- Which specific condition triggered a given action
- The strategy of a user whose vault has never traded

### Cannot be made private — state this plainly in the product
- That the user runs a bot at all
- Any executed trade, on any public DEX
- **Thresholds, given enough trades.** An observer who records the Pyth price at every
  evaluation and sees which ones produced a BUY can bound `entry_below` from both sides.
  Enough observations narrow it arbitrarily. This is inherent to acting on-chain, not an
  Arcium weakness, and no amount of MPC fixes it. See THREAT_MODEL T-9 for partial
  mitigations (jittered cadence, randomised size, threshold bands) and their limits.

---

## 9. Exact Arcium security assumptions

These are the assumptions the product's privacy claims rest on. If any fails, strategy
confidentiality fails.

1. **At least one Arx node in our cluster is honest.** Cerberus is dishonest-majority for
   privacy: n−1 colluding nodes learn nothing. If *all* collude, strategies are exposed.
2. **No liveness guarantee.** Detect-and-abort: one faulty node can abort any computation.
   Trading must fail closed and tolerate frequent no-results.
3. **BLS aggregate integrity.** Forging a callback requires forging the cluster's aggregate
   BLS signature. Our program trusts `verify_output()` and never the callback transaction's
   Solana signer.
4. **MXE authority is trusted for *historical* strategy confidentiality — and this cannot be
   fixed today.** The MXE authority can `migrate-cluster` to a cluster it controls (fully
   internal clusters are a documented, supported feature) and reconstruct MXE key material,
   then decrypt strategy ciphertexts already published on-chain. There is **no CLI command to
   transfer, burn, or timelock the MXE authority**, and Recovery Peers have **no documented
   veto**. Cluster pinning (§7.1) makes migration halt the system and blocks forged
   authorizations, but cannot un-publish ciphertext. **Any "private from the operator" claim
   must be qualified accordingly.**
5. **Recovery peers are trusted.** ≥4 nodes hold encrypted shares of the MXE key. Their stake
   is role-bound on-chain, but they cannot refuse a migration.
6. **Program upgrade authority is trusted** until timelocked — standard Solana. See §9.1.

### 9.1 Authority configuration (production)

| Authority | V1 (devnet) | Production (mainnet gate) |
|-----------|-------------|---------------------------|
| Vault program upgrade | Deployer keypair | **Squads multisig + timelock** |
| MXE authority | Deployer keypair | Squads multisig **if Arcium supports it** — unverified, see Q-A |
| Guardian (pause only) | Deployer keypair | Separate multisig; can pause, never withdraw |

Sequencing matters: fresh MXE init **requires the program's upgrade authority to sign**, and an
immutable program "can never initialize a fresh MXE." So the order is: deploy → init MXE →
*then* transfer upgrade authority to the multisig.

**Do not make the program immutable.** It would forfeit both bug fixes and any future MXE
re-initialization. A timelocked multisig is the correct end state — it makes upgrades public and
delayed rather than impossible.

**Honest claim wording:**

> Non-custodial vault architecture: the platform operator holds no key that can withdraw,
> redirect, or arbitrarily trade user funds. Strategy parameters are evaluated under
> multi-party computation and remain confidential as long as at least one node in the
> cluster is honest. Executed trades are public, and a determined observer can narrow your
> thresholds by watching them over time. Separately, the operator holds the Arcium MXE
> authority; exercising it would halt all bots visibly on-chain, but would also let the
> operator decrypt previously stored strategies. We disclose this rather than claim
> protection we do not have.

**Claims we will not make:** "unruggable", "completely invisible", "impossible to front-run".

---

## 10. MagicBlock

**Excluded from V1 and V2.** Evaluated twice, including a dedicated pass on whether it can
accelerate the accounts *we* control. Full analysis: [`docs/magicblock-evaluation.md`](docs/magicblock-evaluation.md).

The blocking fact is not that a Jupiter swap cannot run in an ER — it is that **delegated
accounts are locked on L1**. Both mandatory L1 writes in this design target the accounts we
would want to delegate:

- the Arcium **BLS callback** writes `TradeIntent` — an L1 transaction, so a delegated
  `TradeIntent` would make the callback fail;
- `execute_trade` writes `consumed`, `vault.nonce`, cooldown and daily-loss counters while
  CPI-ing Jupiter.

**Delegation and Arcium-attested authorization are mutually exclusive over the same accounts.**
Every account on the critical path must therefore stay undelegated, which leaves no ER-resident
state on that path and no latency for the ER to remove. The only safely delegatable accounts
(analytics, trade history) are off the trade path by construction, so their benefit there is
zero.

Independently disqualifying: any variant touching funds or gating makes user withdrawal depend
on ER validator liveness — undelegation is initiated on the ER and finalised "through validator
CPI", with no documented user-initiated force-undelegation. That alone fails the core
non-custodial requirement.

Revisit if the product adds an internal matching engine (where our own order state becomes the
hot path — the case MagicBlock's stack is genuinely built for), or if Arcium benchmarks come
back sub-second, making the ~400 ms L1 legs the dominant term.

---

## 11. Latency budget

| Stage | Expected | Source |
|-------|----------|--------|
| Pyth read + queue tx | ~0.4–1 s | Solana slot time |
| Arcium MPC + callback | **unknown — must benchmark** | Not published; 72 s queue TTL, 120 s client default |
| Executor picks up intent | ~0.4–2 s | our scheduling |
| Jupiter swap confirm | ~0.4–2 s | Solana |

Total is dominated by an unmeasured MPC term. **Benchmark before any latency claim.** Position
the product as automated rule execution, not high-frequency trading.

### 11.1 Is seconds-to-tens-of-seconds acceptable? — Yes, for this strategy class

The V1 strategy language is `PRICE < X → BUY` / `PRICE > Y → SELL` with a stop. These are
**threshold** strategies over horizons of hours to days. They are not latency-competitive:
nobody else is racing to hit *your* private threshold, because nobody else knows it. The
economically relevant question is whether the price is still near the trigger when execution
lands — and for the moves these strategies target, a few seconds is immaterial.

Three honest caveats, all of which resolve in the safe direction:

1. **Fast markets:** in a sharp move, price can travel past the trigger before execution.
   `min_amount_out` and the Pyth deviation band mean the trade then **fails rather than fills
   badly**. Users must understand the bot may simply not fire during a flash crash — that is
   correct behaviour, not a defect.
2. **Stop-losses are the weakest fit.** A stop is the one rule where latency genuinely costs
   money. Document that these are *not* guaranteed-execution stops.
3. **Not suitable for:** arbitrage, momentum scalping, liquidation hunting, or anything where
   being first matters. Say so in the product copy.

**Conclusion: latency is acceptable and not a blocker.** It constrains which strategies the
product should advertise, which V1 scope already reflects.

---

## 12. Repository structure

Adjusted from the brief's suggestion: no separate `arcium/` tree, because `arcium build`
expects circuits inside the Anchor workspace layout.

```
private-trading-platform/
├── programs/vault/           # Anchor program: custody, limits, intents, swap CPI
├── encrypted-ixs/            # Arcis circuits (Arcium workspace convention)
├── apps/
│   ├── web/                  # Next.js — builder, wallet, client-side encryption
│   └── api/                  # untrusted: scheduling, indexing, RPC relay
├── packages/
│   ├── sdk/                  # TS client: encryption, tx building
│   ├── types/                # shared strategy/intent types
│   └── config/               # mints, allowlists, cluster offsets
├── tests/
│   ├── unit/                 # circuit + program logic
│   ├── surfpool/             # mainnet-fork: Jupiter, Pyth, vault
│   └── e2e/                  # devnet full loop
├── scripts/
├── docs/
├── RESEARCH.md  ARCHITECTURE.md  THREAT_MODEL.md  SECURITY.md  README.md
└── .env.example
```

---

## 13. V1 scope

Goal: a genuinely non-custodial vault with genuinely private rule evaluation, on devnet,
with honest claims. Not a scaling story.

- Vault program: `initialize_vault`, `deposit`, `withdraw`, `pause`, `resume`,
  `submit_strategy`, `evaluate_strategy`, `evaluate_callback`, `execute_trade`
- One pair: **USDC ↔ SOL**, both mints hard-allowlisted
- Strategy: `entry_below`, `exit_above`, `stop_below`, `size_bps` — visual builder only
- `Enc<Mxe, Strategy>` persistent encrypted state
- **Cluster pinning (§7.1)** on both Arcium instructions — custody-critical
- Pyth trigger + on-chain freshness/confidence/deviation guards
- Jupiter Router `/build` CPI with `maxAccounts` capping
- Full risk controls: trade cap, daily loss limit, slippage, cooldown, circuit breaker
- Permissionless executor + a "self-execute" button in the UI
- Devnet end-to-end, plus Surfpool mainnet-fork tests for the swap/oracle path
- SECURITY.md with the exact claims from §9

**Explicitly out of V1:** MagicBlock, user code, multiple pairs, multiple strategies per
vault, mainnet.

## 14. V2 scope

- Restricted DSL compiling to a **fixed-shape** circuit: bounded opcode array, fixed
  interpreter iterations, whitelisted operations only. Not arbitrary code.
- More pairs; per-pair allowlists and liquidity floors
- Multiple concurrent strategies per vault
- Jittered evaluation cadence + randomised sizing to blunt threshold inference (T-9)
- MXE authority moved to timelocked multisig, or an independent Arx node run by us to
  guarantee the honest-node assumption
- Mainnet, after external audit
- Portfolio/backtest UI that leaks minimal strategy information

**Still excluded in V2:** MagicBlock; arbitrary user-supplied code.
