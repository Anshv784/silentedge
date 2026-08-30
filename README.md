# SilentEdge

Non-custodial Solana trading vaults where your strategy thresholds are evaluated inside
Arcium's MPC network, so the platform operator never sees them.

## Status — read this first

> **Working on devnet. Not audited. Not on mainnet. Do not use with real funds.**
>
> The program's **upgrade authority is a single hot key** — a plain system-owned keypair, not
> a multisig. Every custody statement below describes the **bytecode running today**, not a
> promise about tomorrow's: whoever holds that key can replace `withdraw`. Moving it to a
> multisig is the one blocker on mainnet. `scripts/check-upgrade-authority.mjs` refuses a
> deploy while the authority is a plain keypair, and **exits 1 today**.

| What | Grade | Evidence |
|------|-------|----------|
| Browser-encrypted strategy → MPC evaluation on live Pyth SOL/USD → BLS-attested callback → withdraw | Verified end to end against the **live devnet cluster** | `tests/e2e-devnet.ts` |
| The swap that spends an authorization (devnet has no routable liquidity) | Verified on a **surfpool mainnet fork** with a live Jupiter route | `tests/swap-execution.ts` |
| Cluster pinning (T-37), the most custody-critical check in the program | **CODED, not ENFORCED** — the derivation has Rust unit tests, the call site has no runtime detector. A previous test claimed to catch its removal; a mutation run proved it did not. | `SECURITY.md` |
| Program upgrade authority (T-3) | **UNVERIFIED** | `SECURITY.md` |

The last full pass found eight real issues: seven fixed, one not — T-37 above. Two of the
fixed ones would have cost a user money: a cooldown that disabled the stop-loss, and a
strategy replacement that left the old strategy trading. Both now have detectors confirmed by
deleting the fix and watching the test fail. Enforced, merely coded, and claimed-but-absent
are graded threat by threat in [`SECURITY.md`](SECURITY.md).

## What it does

1. Connect a Solana wallet and create a vault — a PDA controlled by the program, not by us.
2. Build a strategy visually, e.g. *buy SOL below $150, sell above $180, stop at $120*.
3. The strategy is **encrypted in your browser** before it leaves it, and stored on-chain as
   confidential state.
4. Arcium's MPC network evaluates it against a Pyth price and outputs only `BUY`, `SELL` or
   `HOLD`. Inputs are secret-shared across nodes; under its dishonest-majority model your
   parameters stay private as long as at least one node is honest.
5. The result returns in a callback carrying a **BLS threshold signature from the whole
   cluster**, verified on-chain in our program. The operator cannot forge one; a compromised
   backend can only refuse to schedule work — a liveness failure, never a safety one. Valid
   results execute via Jupiter.
6. You withdraw to your own wallet whenever you want. Funds leave a vault by exactly two
   paths: a swap between allowlisted mints where both sides stay inside the same vault, or a
   withdrawal signed by the owner. **No instruction in the deployed program accepts an
   operator authority** — a property of the instruction set, not a runtime check.

## What this project does *not* claim

- **The program can still be changed.** No instruction lets the operator withdraw your funds,
  but until the upgrade authority is a timelocked multisig, the operator can replace the
  instructions.
- **Your strategy does not stay hidden forever.** Every executed trade is public, and an
  observer correlating prices against your trades narrows your thresholds over time. That is
  inherent to acting on a public chain; no cryptography fixes it.
- **We hold the Arcium MXE authority.** Using it would halt every bot visibly on-chain and
  cannot forge a trade, but it *would* let us decrypt previously stored strategies. There is
  currently no way to burn or timelock it.
- **Trade intent is briefly public before execution.** Front-running is possible.
- **Not for HFT.** MPC evaluation takes seconds. Suited to threshold strategies over hours and
  days; unsuited to arbitrage, scalping, or stop-losses that must fill at a price.

## Running it locally

**Fast path — the web app against the already-deployed devnet program.** Copy `.env.example`
to `.env` and fill it in, then:

```bash
pnpm install
pnpm --filter @silentedge/web dev        # http://localhost:3000
```

**Full path — build, deploy and test.**

```bash
pnpm surfpool                            # terminal 1: surfpool, forked from devnet
anchor build                             # terminal 2
anchor deploy --provider.cluster http://127.0.0.1:8899
pnpm test:local                          # vault + authorization, against the fork
pnpm test:devnet                         # end-to-end, against the live devnet cluster
pnpm test:fork                           # swap execution, mainnet fork + live Jupiter
```

Forking devnet means the real wSOL and USDC mints exist, so the production allowlist is
genuinely exercised ([`docs/testing.md`](docs/testing.md)).

**Devnet SOL.** A deploy needs roughly **5.3 SOL of headroom** for the temporary buffer,
refunded afterwards. `solana airdrop` is rate-limited to the point of being unavailable, so
top the deploy wallet up at https://faucet.solana.com or from another devnet wallet first.

Never put a funded keypair path in `.env`. The backend holds no key that can move funds.

## Repository layout

| Path | Contents |
|------|----------|
| `programs/vault/` | Anchor program — custody, limits, intents, swap CPI |
| `encrypted-ixs/` | Arcis circuits (Arcium workspace convention) |
| `programs/hello_arcium/` | Disposable proof the Arcium pipeline works; its strategy circuits are retired |
| `apps/web/` | Next.js — dashboard, strategy studio, client-side encryption |
| `apps/api/` | Untrusted service — scheduling, indexing, RPC relay |
| `packages/` | `sdk` strategy encryption (RescueCipher + x25519), `types` model and validation, `config` mints and allowlists |
| `tests/` | Local-fork, live-devnet and mainnet-fork suites |
| `scripts/` | Upgrade-authority check, circuit registration, fork seeding |

Verified toolchain: Rust 1.97.1, Solana CLI 3.1.11 (Agave), Anchor 1.1.2, Arcium 0.14.1,
Surfpool 1.5.0, Node 24.7.0, pnpm 11.21.0.

## Documentation

| Document | What it is |
|----------|------------|
| [`SECURITY.md`](SECURITY.md) | Every threat graded ENFORCED / CODED / UNVERIFIED, plus disclosure policy. **Read this before trusting any claim above.** |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The design, and the data, money and strategy flows |
| [`docs/privacy.md`](docs/privacy.md) | What the engine hides, and what leaks anyway |
| [`docs/arcium.md`](docs/arcium.md) | How the MPC pipeline and persistent encrypted state work |
| [`docs/testing.md`](docs/testing.md) | Test environments, coverage, and a false-pass trap |
| [`docs/research.md`](docs/research.md) | Verified findings from official docs, with sources |

Also: [`FEES.md`](FEES.md) (no protocol fee — a fee would be a third way for value to leave a
vault), [`docs/oracle.md`](docs/oracle.md) (why Pyth triggers and Jupiter quotes), and
[`docs/magicblock-evaluation.md`](docs/magicblock-evaluation.md) (why an Ephemeral Rollup
cannot sit on this critical path).

## License

[Apache-2.0](LICENSE). Permissive, with an explicit patent grant — the licence
Solana and Anchor themselves use.
