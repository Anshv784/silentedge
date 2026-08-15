# Arcium hello world

The smallest real Arcium computation — `x + 10` — wired end to end before any
of this machinery is pointed at money.

**Status: working.** `x + 10` has executed on the live Arcium devnet cluster,
`verify_output()` accepted the cluster's BLS-signed result, and decrypting the
callback payload gives 42 for x = 32.

The test skips rather than passes when no cluster is reachable, because a green
tick that proves nothing is worse than a skip.

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

### And a matching split on the TypeScript side

Anchor 1.x ships a **different TS client** from the 0.x line:

| Program built with | TS client |
|--------------------|-----------|
| `@coral-xyz/anchor` 0.3x | `@coral-xyz/anchor` |
| `anchor-lang` 1.x (what Arcium requires) | `@anchor-lang/core` |

Driving an Arcium program with `@coral-xyz/anchor` gets far enough to look like
it works — the workspace resolves, the program ID is right, accounts derive
correctly — and then fails inside the provider with `Unknown action 'undefined'`
at `sendAndConfirm`. The error names nothing useful; the cause is the client
mismatch.

`tests/hello-arcium.ts` therefore imports `@anchor-lang/core`, while the vault
tests stay on `@coral-xyz/anchor`, which is fine for a plain Anchor program.
When the vault gains its own Arcium instructions, its tests will have to move
too.

Two smaller differences that follow from the switch:

- `@anchor-lang/core` does **not** re-export `BN`. Import it from `bn.js`.
- It exports `AnchorProvider`, `Program`, `getProvider`, `setProvider`,
  `workspace`, `utils`, and `web3` — but no `BN`, so the usual
  `anchor.BN` idiom fails at runtime with `BN is not a constructor`.

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

## Devnet deployment

Done, on Solana devnet against Arcium's devnet cluster (offset `456`):

| Item | Value |
|------|-------|
| Program | `HVEKKMWwjLaQyXqkMGGshNGXa3Wm1PCSUnRaB6vAnB99` |
| MXE init | [`3z5eQp3H…hCre9q`](https://explorer.solana.com/tx/3z5eQp3HML7wXyfuxbut8j84WA9tafkUJ91a3TNXuBJihpYAfqseH3T8tRWn7oU5MxHYJ8SnmtvGRpUYgDhCre9q?cluster=devnet) |
| Key recovery material | [`2uVEb4P9…FiUY7`](https://explorer.solana.com/tx/2uVEb4P9mZ8Y8CFixhyvq8BRdDR7fgCjqhnF3NvqoNn2wxPJD2jasu4vEnMnXoR8oA55rhKATY8gr7c2uC6FiUY7?cluster=devnet) |
| Recovery set size | 4 |

So the real Arcium devnet cluster has generated and distributed key material for
this MXE. That is the part that needed a live network, and it worked.

Deploy note: an upgradeable program reserves **twice** the binary size for its
data account, so a 466 KB program wants ~6.5 SOL. Passing
`--max-len <exact size>` allocates 1x instead (~3.25 SOL) at the cost of never
being able to upgrade to a larger binary — fine for a disposable demo, wrong for
the vault.

## Registering a circuit is three steps, not one

Easy to get wrong, because the first two succeed on their own and leave an
account that looks finished:

1. `init_*_comp_def` — creates the computation definition account.
2. `uploadCircuit` — writes the circuit bytes into buffer accounts, chunked.
3. **finalize** — marks the definition usable.

Skip step 3 and queueing fails with `ComputationDefinitionNotCompleted`
(error 6300) even though the account exists, `circuitLen` matches the file, and
the buffer reports `isCompleted: true`. Those fields describe the *upload*, not
the definition.

`getCircuitState(compDefAcc.circuitSource)` is the field that actually answers
the question — `OnchainPending` versus `OnchainFinalized`. Note also that
`uploadCircuit` returns early when state is anything other than `OnchainPending`,
so re-running it after a partial upload logs `skipped` and does nothing.

A related trap in our own test: it skipped `initAddTenCompDef` when the comp def
account already existed, which also skipped the upload. Account existence is not
the same as circuit readiness.

## The successful run

Program `FPZkMe1NgT3oug3iLoaWsnPjGAEr3p7mwporhfVqU7Lk` on Solana devnet, against
Arcium's devnet cluster (offset `456`):

| Step | Signature |
|------|-----------|
| MXE init + key recovery material | [`4qfG3x88…`](https://explorer.solana.com/tx/4qfG3x88Q6DN4YCoS6xgWb6xbgoUBkVCpsc6NF85dGgtbkKNoPsW3NiFV8ocba5RGUn3fhR3DvPforKkCWk84ZzQ?cluster=devnet) |
| Queue `add_ten` | [`5FupwnPX…`](https://explorer.solana.com/tx/5FupwnPXHTexR9Y1z464hv9bD2Rhas1zuwviAzd33h8SrqVBacSnF5fbQxXUar2RBVcwSPhKZbsTZ9Tfp5mVHGoz?cluster=devnet) |
| **Cluster callback, `verify_output` OK** | [`4n9nZAyk…`](https://explorer.solana.com/tx/4n9nZAyk4SyNWxkd37rgcD4T2t5dFsR62amjDJfNnEBCkvZwockucdH8axsDawrV2HSYevUFxnzXzG7AUkThHayz?cluster=devnet) |

```
queued:    5FupwnPXHTexR9Y1z464hv9bD2Rhas1zuwviAzd33h8SrqVBacSnF5fbQxXUar2RBVcwSPhKZbsTZ9Tfp5mVHGoz
finalized: 3LzQL2bxdkLpdGRWt47oE41EPbip3xf33QhF2x8GHn5SYxrhdd1cVc71n5qSPrJvq51ZztcwGMeEaZo3ny48NPg4
✔ computes x + 10 without revealing x (11555ms)
1 passing
```

All three claims are now demonstrated rather than asserted: the result arrived
through a cluster-signed callback, `x` never appeared in the ciphertext or the
queue transaction, and decrypting gave 42.

### First real latency number

**~11.6 s** from queueing to a verified result, on devnet, for the smallest
possible circuit. That is one sample on a shared devnet cluster, not a
benchmark — but it is the first evidence for the latency budget in
ARCHITECTURE §11, and it sits squarely in the "seconds, not milliseconds" range
that shaped the product's positioning. A real strategy circuit will not be
meaningfully slower, since the encryption envelope dominates (see above), but
the queue wait depends on cluster load.

### One quirk worth knowing

`awaitComputationFinalization` returned a *later* transaction than the one that
actually succeeded — a duplicate callback attempt that failed with
`AlreadyCallbackedComputation` (6204). The successful callback is the earlier
`4n9nZAyk…`. Do not treat the signature it returns as proof of success; check
the emitted event, which is what the test asserts on.

### The actual cause: a corrupt circuit we uploaded

The first guess — version skew against the devnet nodes — was **wrong**, and
worth recording as wrong. Every component is on the same version:

| Component | Version |
|-----------|---------|
| `arcium` CLI | 0.14.1 |
| `@arcium-hq/client` | 0.14.1 |
| `arcis` (circuit crate) | 0.14.1 |
| `arcium-anchor` / `arcium-client` | 0.14.1 |

Reading the bytes settled it. The on-chain raw-circuit account holds a
**different circuit than the one we compiled**:

```
local  build/add_ten.arcis   62,534 bytes  sha256 6d17f6b4…
onchain raw circuit acc 0    62,543 bytes  (9-byte header + payload)
        first differing byte at offset 814
        1,485 trailing bytes never written
```

814 is not a coincidence: the Arcium `uploadCircuit` instruction takes a
**fixed 814-byte chunk** plus an offset. Chunk 0 landed; later chunks did not.
That is the rate-limited first upload attempt, which died partway through.

Two things then conspired to hide it:

1. **`isCompleted` is a flag, not a checksum.** `getCircuitState` returns
   `OnchainFinalized` by reading `circuitSource.onChain[0].isCompleted` — it
   never compares the stored bytes to anything. A half-written circuit reports
   as finalized.
2. **`uploadCircuit` returns early unless the state is `OnchainPending`.** Every
   later attempt to fix the upload logged `skipped` and did nothing.

So the cluster was faithfully fetching a corrupt circuit, failing to execute it,
and aborting — exactly as a detect-and-abort protocol should. Nothing was wrong
with Arcium, the cluster, or the callback wiring.

**The lesson worth keeping:** there is no on-chain integrity check binding the
stored circuit to the artifact you built. `build/add_ten.hash` exists locally
(it is the sha256 of the `.arcis` file) but nothing on chain verifies it.
Verifying the upload is the integrator's job.

`tests/hello-arcium.ts` now does it: after any upload path it reads the raw
circuit account back and compares it byte for byte with `build/add_ten.arcis`,
failing with the offset and chunk index if they differ. A corrupt upload should
fail immediately and say so, not surface hours later as an unexplained
`verify_output` failure.

### Recovering from a corrupt upload

A finalized circuit is immutable — rewriting chunks returns
`ComputationDefinitionAlreadyCompleted` (6303). The definition has to be torn
down and rebuilt:

```bash
OFF=<comp offset>      # Buffer.from(getCompDefAccOffset("add_ten")).readUInt32LE()
PID=<mxe program id>

arcium deactivate-computation-definition -o $OFF -p $PID -k <kp> -u <rpc>
# wait 180 slots (~72s)
arcium close-computation-definition-buffers -o $OFF -p $PID -i 0 -k <kp> -u <rpc>
arcium close-computation-definition -o $OFF -p $PID -c 456 -k <kp> -u <rpc>
```

Two waits, not one. The buffers close after the definition's own TTL, but
`close-computation-definition` additionally fails with
`ComputationDefinitionHasActiveComputations` (6308) until every computation
queued against it has finalized or expired — each of those has its own 180-slot
life. Closing reclaims rent, which matters when the wallet is nearly empty from
the failed attempts.

**The second wait may not end.** On devnet this step failed 24 consecutive times
across ~12 minutes, long after the definition's own TTL was satisfied
(6,213 slots since deactivation, against a 180-slot requirement). Decoding the
cluster's executing pool shows why: it is **shared across every MXE on the
cluster** and holds entries queued millions of slots ago. Clearing them is not
something an integrator can do from the outside.

So the documented teardown path is not reliably available on a shared cluster.
Two ways around it:

- **Rename the circuit.** The comp-def offset derives from the instruction name,
  so `add_ten` → `add_ten_v2` yields a fresh definition and skips the teardown
  entirely. Requires redeploying the program.
- **Use a local cluster**, where the pool is yours and disposable.

Which points at a deployment rule worth following: **do not pass `--max-len` on
a program you may need to redeploy.** Sizing the data account to the exact
binary halves the initial cost and then blocks every upgrade — the rebuilt
binary here came out 32 bytes larger (466,744 vs 466,712) and could not be
upgraded in place, which is precisely what made the rename unavailable as a
recovery route.

## Cost of the devnet run

Measured, on a fresh deployment:

| Step | SOL |
|------|-----|
| Program deploy (466,712 bytes, upgradeable) | 3.252991 |
| MXE init + key recovery material | 0.133076 |
| Comp def + circuit upload (62,534 bytes) + finalize | 0.438467 |
| One `x + 10` computation | 0.005138 |
| **Total** | **3.829673** |

The program dominates: the actual computation costs about half a cent's worth
of devnet SOL. Note this deploy did **not** pass `--max-len`, so the program
remains upgradeable — see the rule at the end of this document.

## Registering a circuit is three steps, not one

Easy to get wrong, because the first two succeed on their own and leave an
account that looks finished:

1. `init_*_comp_def` — creates the computation definition account.
2. `uploadCircuit` — writes the circuit bytes into buffer accounts, chunked.
3. **finalize** — marks the definition usable.

Skip step 3 and queueing fails with `ComputationDefinitionNotCompleted`
(error 6300) even though the account exists, `circuitLen` matches the file, and
the buffer reports `isCompleted: true`. Those fields describe the *upload*, not
the definition.

`getCircuitState(compDefAcc.circuitSource)` is the field that actually answers
the question — `OnchainPending` versus `OnchainFinalized`. Note also that
`uploadCircuit` returns early when state is anything other than `OnchainPending`,
so re-running it after a partial upload logs `skipped` and does nothing.

A related trap in our own test: it skipped `initAddTenCompDef` when the comp def
account already existed, which also skipped the upload. Account existence is not
the same as circuit readiness.

## The successful run

Program `FPZkMe1NgT3oug3iLoaWsnPjGAEr3p7mwporhfVqU7Lk` on Solana devnet, against
Arcium's devnet cluster (offset `456`):

| Step | Signature |
|------|-----------|
| MXE init + key recovery material | [`4qfG3x88…`](https://explorer.solana.com/tx/4qfG3x88Q6DN4YCoS6xgWb6xbgoUBkVCpsc6NF85dGgtbkKNoPsW3NiFV8ocba5RGUn3fhR3DvPforKkCWk84ZzQ?cluster=devnet) |
| Queue `add_ten` | [`5FupwnPX…`](https://explorer.solana.com/tx/5FupwnPXHTexR9Y1z464hv9bD2Rhas1zuwviAzd33h8SrqVBacSnF5fbQxXUar2RBVcwSPhKZbsTZ9Tfp5mVHGoz?cluster=devnet) |
| **Cluster callback, `verify_output` OK** | [`4n9nZAyk…`](https://explorer.solana.com/tx/4n9nZAyk4SyNWxkd37rgcD4T2t5dFsR62amjDJfNnEBCkvZwockucdH8axsDawrV2HSYevUFxnzXzG7AUkThHayz?cluster=devnet) |

```
queued:    5FupwnPXHTexR9Y1z464hv9bD2Rhas1zuwviAzd33h8SrqVBacSnF5fbQxXUar2RBVcwSPhKZbsTZ9Tfp5mVHGoz
finalized: 3LzQL2bxdkLpdGRWt47oE41EPbip3xf33QhF2x8GHn5SYxrhdd1cVc71n5qSPrJvq51ZztcwGMeEaZo3ny48NPg4
✔ computes x + 10 without revealing x (11555ms)
1 passing
```

All three claims are now demonstrated rather than asserted: the result arrived
through a cluster-signed callback, `x` never appeared in the ciphertext or the
queue transaction, and decrypting gave 42.

### First real latency number

**~11.6 s** from queueing to a verified result, on devnet, for the smallest
possible circuit. That is one sample on a shared devnet cluster, not a
benchmark — but it is the first evidence for the latency budget in
ARCHITECTURE §11, and it sits squarely in the "seconds, not milliseconds" range
that shaped the product's positioning. A real strategy circuit will not be
meaningfully slower, since the encryption envelope dominates (see above), but
the queue wait depends on cluster load.

### One quirk worth knowing

`awaitComputationFinalization` returned a *later* transaction than the one that
actually succeeded — a duplicate callback attempt that failed with
`AlreadyCallbackedComputation` (6204). The successful callback is the earlier
`4n9nZAyk…`. Do not treat the signature it returns as proof of success; check
the emitted event, which is what the test asserts on.

### The actual cause: a corrupt circuit we uploaded

The first guess — version skew against the devnet nodes — was **wrong**, and
worth recording as wrong. Every component is on the same version:

| Component | Version |
|-----------|---------|
| `arcium` CLI | 0.14.1 |
| `@arcium-hq/client` | 0.14.1 |
| `arcis` (circuit crate) | 0.14.1 |
| `arcium-anchor` / `arcium-client` | 0.14.1 |

Reading the bytes settled it. The on-chain raw-circuit account holds a
**different circuit than the one we compiled**:

```
local  build/add_ten.arcis   62,534 bytes  sha256 6d17f6b4…
onchain raw circuit acc 0    62,543 bytes  (9-byte header + payload)
        first differing byte at offset 814
        1,485 trailing bytes never written
```

814 is not a coincidence: the Arcium `uploadCircuit` instruction takes a
**fixed 814-byte chunk** plus an offset. Chunk 0 landed; later chunks did not.
That is the rate-limited first upload attempt, which died partway through.

Two things then conspired to hide it:

1. **`isCompleted` is a flag, not a checksum.** `getCircuitState` returns
   `OnchainFinalized` by reading `circuitSource.onChain[0].isCompleted` — it
   never compares the stored bytes to anything. A half-written circuit reports
   as finalized.
2. **`uploadCircuit` returns early unless the state is `OnchainPending`.** Every
   later attempt to fix the upload logged `skipped` and did nothing.

So the cluster was faithfully fetching a corrupt circuit, failing to execute it,
and aborting — exactly as a detect-and-abort protocol should. Nothing was wrong
with Arcium, the cluster, or the callback wiring.

**The lesson worth keeping:** there is no on-chain integrity check binding the
stored circuit to the artifact you built. `build/add_ten.hash` exists locally
(it is the sha256 of the `.arcis` file) but nothing on chain verifies it.
Verifying the upload is the integrator's job.

`tests/hello-arcium.ts` now does it: after any upload path it reads the raw
circuit account back and compares it byte for byte with `build/add_ten.arcis`,
failing with the offset and chunk index if they differ. A corrupt upload should
fail immediately and say so, not surface hours later as an unexplained
`verify_output` failure.

### Recovering from a corrupt upload

A finalized circuit is immutable — rewriting chunks returns
`ComputationDefinitionAlreadyCompleted` (6303). The definition has to be torn
down and rebuilt:

```bash
OFF=<comp offset>      # Buffer.from(getCompDefAccOffset("add_ten")).readUInt32LE()
PID=<mxe program id>

arcium deactivate-computation-definition -o $OFF -p $PID -k <kp> -u <rpc>
# wait 180 slots (~72s)
arcium close-computation-definition-buffers -o $OFF -p $PID -i 0 -k <kp> -u <rpc>
arcium close-computation-definition -o $OFF -p $PID -c 456 -k <kp> -u <rpc>
```

Two waits, not one. The buffers close after the definition's own TTL, but
`close-computation-definition` additionally fails with
`ComputationDefinitionHasActiveComputations` (6308) until every computation
queued against it has finalized or expired — each of those has its own 180-slot
life. Closing reclaims rent, which matters when the wallet is nearly empty from
the failed attempts.

**The second wait may not end.** On devnet this step failed 24 consecutive times
across ~12 minutes, long after the definition's own TTL was satisfied
(6,213 slots since deactivation, against a 180-slot requirement). Decoding the
cluster's executing pool shows why: it is **shared across every MXE on the
cluster** and holds entries queued millions of slots ago. Clearing them is not
something an integrator can do from the outside.

So the documented teardown path is not reliably available on a shared cluster.
Two ways around it:

- **Rename the circuit.** The comp-def offset derives from the instruction name,
  so `add_ten` → `add_ten_v2` yields a fresh definition and skips the teardown
  entirely. Requires redeploying the program.
- **Use a local cluster**, where the pool is yours and disposable.

Which points at a deployment rule worth following: **do not pass `--max-len` on
a program you may need to redeploy.** Sizing the data account to the exact
binary halves the initial cost and then blocks every upgrade — the rebuilt
binary here came out 32 bytes larger (466,744 vs 466,712) and could not be
upgraded in place, which is precisely what made the rename unavailable as a
recovery route.

## Cost of the devnet run

`uploadCircuit` writes the 62 KB circuit to chain in chunks. At 900 bytes per
transaction that is ~70 transactions in quick succession, and
`api.devnet.solana.com` rate-limits it into the ground: continuous HTTP 429s,
then a stall with no further transactions landing.

This is exactly the failure the Arcium docs warn about — *"Solana's default RPC
endpoints can drop transactions during deployment"* — and it is a property of
the endpoint, not of the code.

**To finish, one of:**

1. **A devnet RPC endpoint with a real rate limit** (Helius, QuickNode, Alchemy;
   free tiers are sufficient). Then:

   ```bash
   ANCHOR_PROVIDER_URL=<your-devnet-rpc>    ANCHOR_WALLET=~/.config/solana/summit-devnet.json    ARCIUM_CLUSTER_OFFSET=456    npx ts-mocha -p ./tsconfig.json -t 300000 'tests/hello-arcium.ts'
   ```

2. **A working Docker engine**, then `arcium localnet` and `arcium test`. Docker
   Desktop's UI starts but its engine does not respond on this machine, so the
   local path is unavailable without intervention.

Also worth knowing: devnet SOL is needed and `solana airdrop` is currently
rate-limited too, so the wallet cannot be topped up from the CLI. The web faucet
or an RPC provider's faucet is the fallback.

## Open item

Until the computation actually executes, the claim "computation runs through
Arcium" is **deployed and wired, not demonstrated**. The circuit compiles, the
programs build, the MXE is live with real cluster key material, and the test is
written — but the loop has not closed. That gap is why the test skips instead of
passing, and it should close before Phase 8 builds persistent encrypted state on
top of it.
