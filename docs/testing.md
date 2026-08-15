# Testing

## Environment

Tests run against **Surfpool forked from devnet**, not a bare local validator.

That is not incidental. The vault hard-codes its mint allowlist to the real
wSOL and devnet-USDC addresses, so on a bare validator those accounts would not
exist and the tests would have to run against stand-in mints — i.e. they would
not exercise the production allowlist at all. Forking devnet means the
allowlist under test is the one that ships.

It is also the environment the later phases need anyway: Jupiter's program and
pool accounts and Pyth's price feeds cannot be reproduced locally, and devnet
liquidity is not representative.

## Running

```bash
# 1. Start the fork (leave running)
surfpool start --network devnet --no-deploy

# 2. Build and deploy
anchor build
anchor deploy --provider.cluster http://127.0.0.1:8899

# 3. Run the suite
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-mocha -p ./tsconfig.json -t 120000 'tests/**/*.ts'
```

## Funding test accounts

Circle holds the devnet USDC mint authority, so tests cannot mint. Surfpool's
cheatcode writes balances directly and creates the ATA if needed:

```ts
await connection._rpcRequest("surfnet_setTokenAccount", [
  owner.toBase58(),
  QUOTE_MINT.toBase58(),
  { amount: 1_000_000 },
]);
```

## Why TypeScript rather than Rust

Anchor 1.x scaffolds `litesvm` + `cargo test`. That path was tried and
abandoned: `litesvm` 0.15 does not compile against the `solana-*` crate
versions `anchor-spl` 1.1.2 pulls in (`ExecutionRecord` changed shape), and
`litesvm` 0.10 puts two incompatible `Pubkey`/`Address` types in the same tree.

TypeScript sidesteps the Rust version churn entirely, and the Arcium phases
require a TypeScript client (`@arcium-hq/client`) regardless — so this keeps one
test language instead of two.

If `litesvm` and Anchor realign later, moving the pure-logic tests to Rust would
be worth it for speed. The current suite runs in ~16s, so this is not urgent.

## A trap worth knowing about

An early version of `cannot initialize the same vault twice` passed for the
wrong reason. Re-sending an *identical* instruction produces an identical
transaction signature, so the runtime rejects it as "already processed" — the
account-already-exists path never ran. The fix is to vary the instruction data
so the second attempt is a genuinely different transaction.

The general rule: when a negative test passes, confirm **which** error it
produced. The suite asserts on specific codes (`ConstraintSeeds`,
`ConstraintTokenOwner`, `VaultNotActive`, …) rather than merely that something
was thrown, because "it threw" is not evidence the control works.

## Browser flows

The program tests build instructions their own way, so they do not exercise the
account wiring in `apps/web/lib/vault-program.ts`. That path is verified by
driving the real UI against the fork.

There is no wallet extension in an automation browser, so a Wallet Standard
provider is injected at runtime that signs with **WebCrypto Ed25519** over a
funded throwaway keypair. It signs genuine transactions — create vault, deposit,
withdraw all land on chain and the resulting balances are checked against the
chain independently of what the UI displays.

This harness is injected per session and is deliberately not committed: it is a
test fixture holding a private key, and it has no place in the app bundle.

## Coverage

Mapped to THREAT_MODEL.md §9. 27 tests.

| Area | Covered |
|------|---------|
| Init | happy path, limits above ceiling, zero limits, double-init |
| Deposit | happy path, zero amount, blocked while paused |
| Withdraw | happy path, over-balance, zero amount |
| **Withdraw while paused** | **must succeed** — pausing must never trap funds (T-4) |
| **Withdraw while stopped** | **must succeed** — wind-down, not a trap |
| Account substitution | foreign vault config (`ConstraintSeeds`), destination substitution (`ConstraintTokenOwner`), foreign vault ATA (`ConstraintTokenOwner`) |
| Status | owner pause/resume, stranger rejected on all three, stopped is terminal |
| Structural | `withdraw` account list pinned — fails if a future phase adds a dependency |
| Layout | vault status byte offset pinned, since the web app reads it directly |
| Amounts | `toBaseUnits` — float-lossy cases, over-precision refusal, malformed input |

Not yet covered, because the code does not exist: trade authorization, cluster
pinning, oracle guards, swap execution. Those arrive with their phases.
