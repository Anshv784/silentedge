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
#    Use --rpc-url, not --network devnet: the latter forks the throttled public
#    endpoint and the suite dies on "Blockhash not found" partway through.
surfpool start --rpc-url "$DEVNET_RPC" --no-deploy

# 2. Build and deploy
anchor build
anchor deploy --provider.cluster http://127.0.0.1:8899

# 3. Run the suite
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-mocha -p ./tsconfig.json -t 120000 'tests/**/*.ts'
```

## Funding test accounts

Circle holds the devnet USDC mint authority, so tests cannot mint it. On the
fork, Surfpool's cheatcode writes balances directly and creates the ATA if
needed:

```ts
await connection._rpcRequest("surfnet_setTokenAccount", [
  owner.toBase58(),
  QUOTE_MINT.toBase58(),
  { amount: 1_000_000 },
]);
```

On real devnet that cheatcode does not exist, and this is not cosmetic: the
circuit sizes a trade from the vault's quote balance, so a vault that cannot be
funded evaluates every strategy to a zero-sized trade and the positive
authorization path never runs. The suite would pass while proving only that
nothing happens.

So devnet's `QUOTE_MINT` is our own 6-decimal mint,
`36X5x8D8jc15XD971iSC9cAB5puaA7zXc6dggA96rxbw`, rather than Circle's. It is a
fixture and nothing more — the mainnet arm of the `#[cfg]` in
`programs/vault/src/constants.rs` still points at real USDC, and the mint
address must stay in sync with `packages/config/src/index.ts` or
`initialize_vault` rejects the vault.

```bash
spl-token create-token --decimals 6 --mint-authority <your-keypair>
spl-token mint <MINT> 10000 --recipient-owner <test-owner>
```

Note that a vault stores its mints at creation, and `evaluate_strategy`
constrains the quote ATA against `vault_config.quote_mint`, not the constant.
Changing the constant therefore does not repoint existing vaults; it needs a
fresh owner, since the vault PDA is seeded by owner.

## No single environment runs the whole path

The two halves of the system need incompatible environments, and pretending
otherwise produces tests that skip without saying so:

| | Jupiter liquidity | Arcium MXE | covers |
|---|---|---|---|
| devnet | no | yes (cluster 456) | strategy → verified callback → `TradeIntent` |
| surfpool **mainnet** fork | yes | no | `TradeIntent` → swap → post-conditions |

Each row has its own script, because `npm test` runs the whole glob and the
environment-gated files *self-skip* — a green run that touched almost nothing
looks identical to a green run that touched everything:

| script | needs | what it proves |
|---|---|---|
| `npm run test:pure` | nothing | encryption, sizing, backtest, executor decisions |
| `npm run test:local` | surfpool devnet fork | custody, authorization structure, account layout |
| `npm run test:devnet` | devnet + Arcium cluster | strategy → verified callback → `TradeIntent` |
| `npm run test:fork` | surfpool mainnet fork, `--features mainnet` | the swap and its post-conditions |


The seam is `TradeIntent`. On the mainnet fork it is written directly with
`surfnet_setAccount`, preserving the discriminator and bump the program itself
wrote and forging only the authorization fields. That is deliberate: a
test-only instruction that writes an intent would put a forged-authorization
path into the shipped program, and `verify_output` cannot be mocked (RESEARCH
§6). The cheatcode keeps the forgery in the test.

The swap suite also needs the `mainnet` feature, or `QUOTE_MINT` is the devnet
test mint, which does not exist on mainnet:

```bash
surfpool start --rpc-url "$MAINNET_RPC" --no-deploy
# -p vault, or cargo tries to pass the feature to hello_arcium, which has none
anchor build -p vault -- --features mainnet
anchor deploy --provider.cluster http://127.0.0.1:8899
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  npx ts-mocha -p ./tsconfig.json -t 300000 tests/swap-execution.ts
```

One Jupiter parameter is load-bearing: `wrapAndUnwrapSol=false`. The default
unwraps wSOL, which closes the vault's wSOL ATA and sends native SOL — the
post-swap balance assertion would fail, and it should, because that is not
where vault funds are supposed to end up.

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

Mapped to THREAT_MODEL.md §9. 58 tests, plus one that skips without a cluster.

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
| Strategy | price parsing, rule ordering, size caps, normalization to the four circuit fields, never-true sentinels |
| Encryption | round trip, derived-key recovery, nonce freshness, no plaintext in ciphertext, wrong-key failure |
| Strategy on chain | storage, version bump, zero-key rejection, stranger rejected, **no plaintext in transaction, account, or logs** |

| Arcium | `x + 10` end to end on the devnet cluster — **passes**; skips only when no cluster is reachable. See [arcium-hello-world.md](arcium-hello-world.md) |
| Strategy state | `Enc<Mxe, Strategy>` stored then read back by a later computation — **passes** on devnet. See [persistent-strategy-state.md](persistent-strategy-state.md) |
| Strategy engine | BUY / HOLD / SELL / stop against the **live Pyth price**, fake-oracle rejection, no threshold on chain — **passes** on devnet. See [oracle.md](oracle.md) and [what-is-private.md](what-is-private.md) |
| Oracle scaling | Pyth exponent handling in both directions, absurd exponents, u64 overflow — Rust unit tests |

Not yet covered, because the code does not exist: trade authorization, cluster
pinning, swap execution. Those arrive with their phases.

A skipped test is not a passing one. `tests/hello-arcium.ts` skips when no MXE
answers, rather than mocking a cluster and reporting green — the whole point of
that test is that the computation happens somewhere we do not control. Against
Arcium devnet it passes in ~11.6 s:

```bash
ANCHOR_PROVIDER_URL=<devnet-rpc> \
ANCHOR_WALLET=~/.config/solana/<your-key>.json \
ARCIUM_CLUSTER_OFFSET=456 \
npx ts-mocha -p ./tsconfig.json -t 1200000 'tests/hello-arcium.ts'
```

Use an RPC with a real rate limit. The circuit upload is ~70 chunked
transactions and public endpoints throttle it into a corrupt partial upload —
which is exactly the failure documented in arcium-hello-world.md.

## Callback account lists must mirror the callback struct

Every account a `#[callback_accounts]` struct declares must also appear in the
`CallbackAccount` list passed to `queue_computation`. Miss one and the
computation runs, gets paid for, and *then* the callback fails at account
resolution with `AnchorError caused by account: <name>`.

Nothing catches this at compile time — the struct and the list are written in
different places and the compiler sees no relationship between them. It also
cannot be caught locally, because reaching a callback at all requires a real
cluster. It cost a devnet deploy cycle to find.

Symptom to recognise: `evaluate_strategy` succeeds, `awaitComputationFinalization`
returns, and the account the callback was supposed to write is untouched. Check
the program's recent transactions for `CallbackComputation` with an
`AnchorError caused by account:` line.

## Box accounts in Arcium callbacks

Anchor account structs are stack-allocated and Solana's frame is 4 KB. A
callback carrying a few application accounts overflows it, and the failure is
`Access violation reading 8 bytes at address 0x… (in unallocated region)` —
nothing that mentions stacks or sizes.

`StrategyState` alone is ~360 bytes; three unboxed accounts alongside the six
standard callback accounts was enough. Boxing them fixed it. Worth doing
pre-emptively in any callback that touches more than a couple of accounts.

Like the account-list mismatch above, this cannot surface locally — reaching a
callback requires a real cluster.

## A dependency footgun worth knowing about

`@arcium-hq/client` 0.14.1 does not bundle for browsers out of the box. Its ESM
entry does `import anchor from "@anchor-lang/core"`, which has no default
export, so webpack rejects it outright. The CJS build is fine but the package's
`exports` map hides it, so `apps/web/next.config.mjs` aliases it by path and
stubs the node builtins it pulls for paths a browser never takes.

Remove the alias once the SDK ships a working ESM entry. It is called out in the
config so nobody has to rediscover it.

## Strategy privacy, checked by hand

The builder holds plaintext, so the claim that it stays in the browser is worth
checking rather than asserting. After saving a draft, with the page driven
through a real browser:

- `localStorage` held only `walletName` — no strategy values, plain or normalized
- `sessionStorage` and cookies held nothing related
- the only network requests were RPC reads to the local validator; no backend
  call carried the values anywhere

Repeated after encryption landed, this time including the chain. Having built
and submitted a strategy through the real UI, with the values 150 / 180.5 / 120
and the name "Range trade":

| Surface | Result |
|---------|--------|
| `localStorage` | only `walletName` — no values, plain or normalized |
| `sessionStorage`, cookies, IndexedDB | nothing related |
| Network requests | only RPC calls to the validator |
| Strategy account (221 bytes) | ciphertext present, no plaintext |
| Transaction JSON | no plaintext |
| Program logs | `Program log: Instruction: SubmitStrategy` and nothing else |

Each value was searched for both as decimal text and as a little-endian u64, on
the grounds that "not present" should hold either way. The same search is
automated in `tests/vault.ts` so a future change that starts logging the payload
fails the suite rather than shipping.
