# Arcium hello world

The smallest real Arcium computation — `x + 10` — wired end to end before any
of this machinery is pointed at money.

**Status: written, compiled, and deployed locally. Not yet executed on a
cluster.** Running it needs either Docker (for `arcium localnet`) or a deployed
MXE on Arcium devnet; see [Running it](#running-it). The test skips rather than
passes when no cluster is reachable, because a green tick that proves nothing is
worse than a skip.

---

## What it demonstrates

Three claims the rest of the product depends on:

1. **The computation runs on a cluster, not locally.** The result arrives
   through a callback the cluster signs. Nothing in our code computes the answer.
2. **The input stays encrypted.** `x` is never revealed to the program or the
   chain — only its ciphertext is.
3. **The result is correct and confidential.** Decrypting the callback payload
   gives `x + 10`, and only the client can decrypt it.

## The circuit

`encrypted-ixs/src/lib.rs`:

```rust
#[encrypted]
mod circuits {
    use arcis::*;

    #[instruction]
    pub fn add_ten(x_ctxt: Enc<Shared, u64>) -> Enc<Shared, u64> {
        let x = x_ctxt.to_arcis();
        let sum = x + 10;
        x_ctxt.owner.from_arcis(sum)
    }
}
```

Three decisions in five lines:

- **`x` is `Enc<Shared, u64>`** — encrypted under a secret shared between the
  client and the MXE. Neither the program nor any single node sees it.
- **`10` is a literal**, baked into the circuit at compile time. It is public by
  construction, and it is not sent anywhere. This is exactly the split the
  strategy circuit will need later: secret thresholds, public market price.
- **The result is `from_arcis`, not `.reveal()`.** `from_arcis` re-encrypts to
  the caller, so only whoever asked can read the answer. `.reveal()` would
  publish it to everyone. The difference between those two calls is the entire
  confidentiality model, and it is worth internalising on a toy before it
  matters.

## What compiling it costs

`arcium build` produces `build/add_ten.arcis` (62 KB) plus a profile. The final
stage of that profile:

| Metric | Value |
|--------|-------|
| Total gates | 9,075 |
| Network depth | 54 |
| Network size | 236,012 |
| Preprocess weight | 8,439,400 |

The number worth staring at: **the addition itself is 3 gates.** The first
profile stage — the arithmetic — is 3. Everything else is the encryption
envelope: decrypting the input inside MPC and re-encrypting the output.

That has a real design consequence. For small circuits the crypto overhead
dominates completely, so the cost of a computation is driven far more by how
many values cross the encryption boundary than by the arithmetic between them.
Evaluating a whole strategy in one computation will cost barely more than
adding two numbers; splitting it across several computations would multiply the
envelope each time.

## The program

`programs/hello_arcium/src/lib.rs` implements the standard three functions:

| Function | Purpose | Called |
|----------|---------|--------|
| `init_add_ten_comp_def` | Register the circuit on chain | Once, ever |
| `add_ten` | Build args, queue the computation | Per request |
| `add_ten_callback` | Verify and handle the result | By the cluster |

Two details that are easy to get wrong:

**Argument order must match the circuit signature exactly.** For
`Enc<Shared, T>` that is `x25519_pubkey`, then `plaintext_u128(nonce)`, then
ciphertexts. Getting it wrong fails silently rather than loudly.

**The callback's trust boundary is `verify_output`, not the transaction signer.**
The callback transaction is signed by an ordinary Arx node keypair and proves
nothing on its own. `verify_output` checks the cluster's BLS threshold signature
over the output. The program trusts that check and nothing else — and it is the
same check that will authorize trades, which is why it is exercised here first.

### Why a separate program

`hello_arcium` is deliberately not part of the vault. Every instruction in a
custody program is attack surface, and a demonstration has no business living
there. It also keeps this disposable: once the strategy circuit works, this
program can be deleted without touching anything that holds funds.

## Toolchain constraint discovered here

**`arcium-anchor` 0.14.1 pins `anchor-lang` to exactly `=1.0.2`.**

The vault was on 1.1.2, and cargo cannot satisfy both. Since the vault must
eventually use `arcium-anchor` itself — `evaluate_strategy` queues a computation
and `evaluate_callback` receives one — the whole workspace moved to 1.0.2 rather
than the other way round.

Worth knowing before an Anchor upgrade: **the workspace's Anchor version is
chosen by Arcium, not by us**, until that pin loosens.

Also note the Arcium macros read the compiled circuit artifacts, so
`cargo build` alone fails with `custom attribute panicked`. Always
`arcium build`, which compiles the circuit first.

## Running it

The test lives in `tests/hello-arcium.ts` and skips when no MXE is reachable.

### Option A — local cluster (needs Docker)

```bash
arcium localnet          # starts a 2-node cluster in Docker
arcium test              # builds, deploys, runs the suite
```

Two nodes, not one, on purpose: Arcium's privacy guarantee is that at least one
node is honest, so a single-node "cluster" would demonstrate nothing.

### Option B — Arcium devnet

```bash
arcium deploy --cluster-offset 456 \
  --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url <your-devnet-rpc>

arcium test --cluster devnet
```

Needs devnet SOL for the program deployment and MXE initialization, and a
reliable RPC — the Arcium docs warn that Solana's default endpoints drop
transactions during deployment. Note the CLI defaults to **mainnet** when
`--rpc-url` is omitted.

### What a successful run prints

```
queued:    <signature>
finalized: <signature>
```

and asserts `decrypted === 42` for `x = 32`.

## What the test checks beyond the answer

Getting `42` back only proves arithmetic. The test also asserts:

- `x` (as a little-endian u64) does not appear in the ciphertext it sends;
- `x` does not appear in the confirmed queue transaction;
- the result arrives via `awaitComputationFinalization` — i.e. from the cluster,
  not from anything running locally.

## Open item

Until this has actually executed on a cluster, the claim "computation runs
through Arcium" is **compiled and wired, not demonstrated**. The circuit
compiles, the programs build, the accounts resolve, and the test is written —
but the loop has not closed. That gap is why the test skips instead of passing,
and it should be closed before Phase 8 builds persistent encrypted state on top
of it.
