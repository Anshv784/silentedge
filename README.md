# SilentEdge

Non-custodial Solana trading vaults with confidential strategy execution.

Create a rule-based trading bot. Your funds stay in a vault only you can withdraw from.
Your strategy parameters are evaluated inside multi-party computation, so they are not
visible to the platform operator or to any single node running the computation.

> **Status: in progress.** Vault program (custody, deposits, withdrawals,
> pause/stop), the web dashboard, the strategy builder, and client-side
> strategy encryption are built and tested against a devnet fork. No MXE is
> deployed yet, so strategies are encrypted to a development key rather than a
> live MPC cluster — the interface says so. Confidential execution and trading
> are not built yet. Nothing here is audited. Do not use with real funds.

---

## What it does

1. Connect a Solana wallet and create a vault (a PDA your program controls, not ours).
2. Build a strategy visually — e.g. *buy SOL below $150, sell above $180, stop at $120*.
3. The strategy is **encrypted in your browser** and stored as confidential state.
4. Arcium's MPC network evaluates it against a Pyth price and outputs only `BUY`/`SELL`/`HOLD`.
5. That result is threshold-attested, verified on-chain, and executed via Jupiter.
6. You withdraw whenever you want. No one else can.

## Why each piece

**Why Solana** — the vault, its limits, and every enforcement rule are a Solana program.
Enforcement lives on-chain because that is the only place it cannot be quietly changed.

**Why Arcium** — a strategy that sits in a database is a strategy your operator can read,
copy, or front-run. Arcium evaluates it under MPC: inputs are secret-shared across nodes, and
under its dishonest-majority model your parameters stay private as long as **at least one node
is honest**, even if every other node colludes.

**Why the vault is non-custodial** — funds leave a vault by exactly two paths: a swap between
two allowlisted mints where both sides stay inside the same vault, or a withdrawal to the
owner's wallet signed by the owner. There is no third path, and **no instruction accepts an
operator key**. That is a property of the instruction set, not a runtime check.

**How trades are authorized** — not by a platform key. Arcium returns results in a callback
carrying a **BLS threshold signature** from the whole cluster, verified on-chain inside our
program. The operator cannot forge one. A fully compromised backend still cannot move funds —
its worst case is refusing to schedule work, which is a liveness failure, never a safety one.

## What we do *not* claim

Being precise here matters more than sounding impressive.

- **Not "unruggable."** The operator cannot withdraw your funds. Until the program upgrade
  authority is a timelocked multisig, the operator *can* change the program.
- **Not "your strategy is invisible."** Every executed trade is public. An observer correlating
  prices with your trades can narrow your thresholds over time. This is inherent to acting
  on a public chain and no amount of cryptography fixes it.
- **Not "private from us, unconditionally."** We hold the Arcium MXE authority. Using it would
  halt every bot visibly on-chain and cannot forge trades, but *would* let us decrypt
  previously stored strategies. There is currently no way to burn or timelock that authority.
- **Not front-running resistant.** Trade intent is briefly public before execution.
- **Not for HFT.** MPC evaluation takes seconds. Suitable for threshold strategies over hours
  and days; unsuitable for arbitrage, scalping, or guaranteed-execution stop-losses.

Full detail: [`THREAT_MODEL.md`](THREAT_MODEL.md) and [`SECURITY.md`](SECURITY.md).

## Architecture at a glance

```
      Browser                      Solana                       Arcium
─────────────────────      ──────────────────────      ────────────────────────
 strategy authored
        │
  encrypted client-side
        │
        └──────────────►  StrategyState
                          Enc<Mxe, Strategy>
                                │
        scheduler ──►  evaluate_strategy ──────────►  MPC evaluation
                       (Pyth price, pinned cluster)    (both branches always run)
                                                              │
                          TradeIntent  ◄────────────  BLS-attested callback
                                │                     verify_output()
                                │
        anyone ──►  execute_trade
                    (limits, allowlists, oracle band)
                                │
                                ▼
                          Jupiter CPI ──► DEX
```

Funds and enforcement on Solana. Strategy and evaluation in Arcium. Routing via Jupiter.

**MagicBlock is deliberately not used.** Delegated accounts are locked on the base layer, and
both the Arcium callback and the swap are base-layer writes to exactly those accounts —
so an Ephemeral Rollup cannot sit on the critical path. Reasoning:
[`docs/magicblock-evaluation.md`](docs/magicblock-evaluation.md).

## Repository layout

| Path | Contents |
|------|----------|
| `programs/vault/` | Anchor program — custody, limits, intents, swap CPI |
| `encrypted-ixs/` | Arcis circuits (Arcium workspace convention) |
| `programs/hello_arcium/` | Disposable proof that the Arcium pipeline works |
| `apps/web/` | Next.js — wallet, balances, strategy builder, client-side encryption |
| `apps/api/` | Untrusted service — scheduling, indexing, RPC relay |
| `packages/sdk/` | Strategy encryption (Arcium RescueCipher + x25519) |
| `packages/types/` | Strategy model, validation, normalization |
| `packages/config/` | Mints, allowlists, cluster offsets |
| `tests/` | Suite run against a Surfpool devnet fork |

## Documentation

| Document | Purpose |
|----------|---------|
| [`RESEARCH.md`](RESEARCH.md) | Verified findings from official docs, with sources |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The design, data/money/strategy flows, V1 and V2 scope |
| [`THREAT_MODEL.md`](THREAT_MODEL.md) | Adversaries, 37 threats, test obligations |
| [`SECURITY.md`](SECURITY.md) | Security assumptions and disclosure policy |
| [`docs/magicblock-evaluation.md`](docs/magicblock-evaluation.md) | Why MagicBlock is excluded |
| [`docs/testing.md`](docs/testing.md) | Test environment, coverage, and a false-pass trap |
| [`docs/arcium-hello-world.md`](docs/arcium-hello-world.md) | The smallest real Arcium computation, and what it cost |

Start with `RESEARCH.md` — `ARCHITECTURE.md` assumes its findings.

## Toolchain

Verified working versions:

| Tool | Version |
|------|---------|
| Rust | 1.97.1 |
| Solana CLI | 3.1.11 (Agave) |
| Anchor | 1.1.2 |
| Arcium | 0.14.1 |
| Surfpool | 1.5.0 |
| Node | 24.7.0 |
| pnpm | 11.21.0 |

## Running locally

```bash
cp .env.example .env          # then fill in
pnpm install

surfpool start --network devnet --no-deploy    # terminal 1

anchor build                                   # terminal 2
anchor deploy --provider.cluster http://127.0.0.1:8899
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  npx ts-mocha -p ./tsconfig.json -t 120000 'tests/**/*.ts'
```

Tests run against Surfpool forked from devnet so the real wSOL and USDC mints
exist and the production allowlist is genuinely exercised. See
[`docs/testing.md`](docs/testing.md).

Never put a funded keypair path in `.env`. The backend holds no key that can move funds.

## License

Not yet chosen.
