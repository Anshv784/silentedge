# Arcium build log

Getting Arcium working end to end on the live devnet cluster: from the smallest
possible computation (`x + 10`) to a strategy that stays encrypted to the
cluster and survives between computations.

**Status: both milestones working on Arcium devnet.** Not audited, not on
mainnet. This logs the throwaway demo program `hello_arcium`, not the vault, and
makes no custody claim — the program upgrade authority is a single hot key today
(finding T-3, graded **UNVERIFIED** in `../SECURITY.md`).

---

## 1. What ran on devnet

| Milestone | What it demonstrates | Test |
|---|---|---|
| `x + 10` on a cluster | The computation runs on the cluster, not locally; `x` is never revealed to the program or the chain; the result returns re-encrypted to the caller and decrypts to 42 for x = 32 | `tests/hello-arcium.ts` |
| `Enc<Mxe, Strategy>` state | A strategy encrypted to the cluster is read back by a **later, separate** computation and decrypts to exactly the values that went in | `tests/strategy-state.ts` |

Program `FPZkMe1NgT3oug3iLoaWsnPjGAEr3p7mwporhfVqU7Lk` on Solana devnet, against
Arcium's devnet cluster (offset `456`), recovery set size 4:

| Step | Signature |
|------|-----------|
| MXE init + key recovery material | [`4qfG3x88…`](https://explorer.solana.com/tx/4qfG3x88Q6DN4YCoS6xgWb6xbgoUBkVCpsc6NF85dGgtbkKNoPsW3NiFV8ocba5RGUn3fhR3DvPforKkCWk84ZzQ?cluster=devnet) |
| Queue `add_ten` | [`5FupwnPX…`](https://explorer.solana.com/tx/5FupwnPXHTexR9Y1z464hv9bD2Rhas1zuwviAzd33h8SrqVBacSnF5fbQxXUar2RBVcwSPhKZbsTZ9Tfp5mVHGoz?cluster=devnet) |
| **Cluster callback, `verify_output` OK** | [`4n9nZAyk…`](https://explorer.solana.com/tx/4n9nZAyk4SyNWxkd37rgcD4T2t5dFsR62amjDJfNnEBCkvZwockucdH8axsDawrV2HSYevUFxnzXzG7AUkThHayz?cluster=devnet) |

```
✔ computes x + 10 without revealing x (11555ms)
✔ stores a strategy as MXE-encrypted state, then reads it back (42153ms)
recovered: 150000000, 180500000, 120000000, 1000
```

The devnet cluster generated and distributed key material for this MXE — the
part that needed a live network. Both tests **skip** rather than pass when no
cluster is reachable.

```bash
arcium localnet && arcium test          # local 2-node cluster, needs Docker
arcium deploy --cluster-offset 456 --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json --rpc-url <your-devnet-rpc>
arcium test --cluster devnet            # needs devnet SOL for deploy + MXE init
```

## 2. Cost and latency

| Circuit | Encrypted fields | Gates | Depth | Network size |
|---|---:|---:|---:|---:|
| `add_ten` | 1 | 9,075 | 54 | 236,012 |
| `store_strategy` | 4 | 20,921 | 54 | 350,256 |
| `export_strategy` | 4 | 20,260 | 54 | 348,080 |

`add_ten` also reports preprocess weight **8,439,400** and compiles to a 62,534
byte `.arcis`.

**The addition itself is 3 gates** — the arithmetic stage of the profile is 3.
Everything else is the encryption envelope: decrypting inputs inside MPC and
re-encrypting outputs. Depth is **identical** across all three; four encrypted
values instead of one roughly doubles gates and leaves depth untouched. So the
design rule is **evaluate a strategy in one computation, not several** — a whole
strategy costs barely more than adding two numbers, and splitting it pays the
envelope each time.

| Run | Computations | Wall clock |
|---|---:|---:|
| `add_ten` | 1 | ~11.6 s (11,555 ms) |
| store, then read back | 2 | ~42 s (42,153 ms) |

Roughly 15–20 s per computation including queueing. Samples on a shared cluster,
not a benchmark, and queue wait depends on load — but they are the first
evidence for the latency budget in `../ARCHITECTURE.md` §11 and sit in the
"seconds, not milliseconds" range that shaped the product's positioning. Each
evaluation needs one computation; the store happens once, when the strategy is
set.

| Devnet SOL, fresh deployment | SOL |
|------|-----|
| Program deploy (466,712 bytes, upgradeable) | 3.252991 |
| MXE init + key recovery material | 0.133076 |
| Comp def + circuit upload (62,534 bytes) + finalize | 0.438467 |
| One `x + 10` computation | 0.005138 |
| **Total** | **3.829673** |

The program dominates; the computation is about half a cent of devnet SOL.
Discrepancy left visible: the same log says an upgradeable program reserves
**twice** the binary size (~6.5 SOL here) and that `--max-len` gives 1x
(~3.25 SOL), yet this deploy did not pass `--max-len` and cost the 1x figure.
See §5, "Program sizing".

## 3. The circuits

`encrypted-ixs/src/lib.rs`. The smallest one:

```rust
#[instruction]
pub fn add_ten(x_ctxt: Enc<Shared, u64>) -> Enc<Shared, u64> {
    let x = x_ctxt.to_arcis();
    let sum = x + 10;
    x_ctxt.owner.from_arcis(sum)
}
```

- **`x` is `Enc<Shared, u64>`** — encrypted under a secret shared between client
  and MXE. Neither the program nor any single node sees it.
- **`10` is a literal**, baked in at compile time, public by construction, sent
  nowhere. Exactly the split the strategy needs: secret thresholds, public price.
- **`from_arcis`, not `.reveal()`.** `from_arcis` re-encrypts to the caller;
  `.reveal()` would publish to everyone. That difference is the entire
  confidentiality model, worth internalising on a toy first.

### How `Enc<Mxe, Strategy>` survives between computations

`Enc<Shared, _>` suits something the user just typed — they can read it back. It
is wrong for a bot: evaluation happens when the price moves, not when the owner
is at their laptop, and it is bound to a key the browser holds. So one
computation re-encrypts it, once:

```rust
#[instruction]
pub fn store_strategy(input: Enc<Shared, Strategy>) -> Enc<Mxe, Strategy> {
    let strategy = input.to_arcis();
    Mxe::get().from_arcis(strategy)
}
```

The stored bytes are then readable only by the cluster acting together — not by
the program, not by the operator, not by the owner's own browser — and the
plaintext exists only inside the MPC, secret-shared across nodes, for the
duration of one computation. That is what lets an unattended evaluation use the
strategy later.

```rust
pub struct Strategy {
    entry_below: u64,
    exit_above: u64,
    stop_below: u64,
    size_bps: u64,
}
```

Fixed shape, because Arcis compiles to circuits whose shape is known at compile
time. Prices are fixed-point with 6 decimals; `size_bps` is basis points of
vault value. A rule the user switched off is stored as a value whose comparison
can never be true (`0` for buy, `u64::MAX` for sell) rather than being absent:
in MPC both branches of a conditional execute regardless, so "off" has to be
indistinguishable from "on". (Four fields as built here; the circuits have since
become `store_strategy_v2` / `evaluate_strategy_v3` and `size_bps` left the
encrypted struct — see `../SECURITY.md` T-38.)

### A circuit cannot authenticate a caller

```rust
#[instruction]
pub fn export_strategy(stored: Enc<Mxe, Strategy>, reader: Shared)
    -> Enc<Shared, Strategy>
```

**This circuit cannot tell who asked.** It re-encrypts to whatever x25519 key it
is handed, so anyone able to queue it could read the strategy. Authorization is
the Solana program's job — the account is seeded by the signer, so a different
signer derives a different address and the constraint rejects it:

```rust
#[account(
    seeds = [STORED_STRATEGY_SEED, payer.key().as_ref()],
    bump = stored_strategy.bump,
)]
pub stored_strategy: Account<'info, StoredStrategy>,
```

It generalises: **a circuit cannot authenticate a caller; only the chain can.**
Every confidential instruction needs its authorization written on the Solana
side.

## 4. What the tests assert beyond the answer

Getting `42` back only proves arithmetic. The suites also assert that:

- `x` (little-endian u64) appears neither in the ciphertext sent nor in the
  confirmed queue transaction;
- the result arrives via `awaitComputationFinalization` — from the cluster, not
  from anything local;
- the submitted strategy ciphertext contains none of the four values (checked as
  little-endian u64 against raw bytes);
- after the store, the on-chain `StoredStrategy` account contains none of them
  either, as bytes or as decimal text;
- that account carries **no client encryption key** — `Enc<Mxe, _>` has no
  shared secret, so the submitter's own key is useless against it;
- a **second, later** computation, different nonce and ephemeral key, reads that
  state and returns it re-encrypted, decrypting to what went in.

The last one is the point: state written by one computation is intact and usable
by another.

## 5. Every gotcha this build hit

### Toolchain and clients

| Trap | Detail |
|---|---|
| Arcium picks your Anchor version | `arcium-anchor` 0.14.1 pins `anchor-lang` to exactly `=1.0.2`. The vault was on 1.1.2, cargo cannot satisfy both, so the whole workspace moved to 1.0.2. |
| `cargo build` alone fails | The macros read compiled circuit artifacts, so plain `cargo build` dies with `custom attribute panicked`. Always `arcium build`. |
| Anchor 1.x ships a different TS client | `anchor-lang` 1.x needs `@anchor-lang/core`; `@coral-xyz/anchor` is the 0.3x line. |
| …and the mismatch fails late and uselessly | With `@coral-xyz/anchor` the workspace resolves, the program ID is right, accounts derive correctly — then the provider fails with `Unknown action 'undefined'` at `sendAndConfirm`, naming nothing useful. |
| `@anchor-lang/core` has no `BN` | It exports `AnchorProvider`, `Program`, `getProvider`, `setProvider`, `workspace`, `utils`, `web3`. `anchor.BN` fails at runtime with `BN is not a constructor`; import `BN` from `bn.js`. |
| Argument order must match the circuit signature | For `Enc<Shared, T>`: `x25519_pubkey`, then `plaintext_u128(nonce)`, then ciphertexts. Wrong order fails silently. |
| The CLI defaults to **mainnet** | `arcium deploy` without `--rpc-url` targets mainnet. Use a reliable devnet RPC — the Arcium docs warn Solana's default endpoints drop transactions during deployment. |
| A local cluster is two nodes, not one | `arcium localnet` starts 2 on purpose: privacy rests on at least one node being honest, so a single-node "cluster" would demonstrate nothing. |

`tests/hello-arcium.ts` imports `@anchor-lang/core`; the vault tests stay on
`@coral-xyz/anchor` and will have to move when the vault gains Arcium
instructions.

### The program side, and where its trust boundary is

`programs/hello_arcium/src/lib.rs` is the standard three functions:
`init_add_ten_comp_def` (register the circuit on chain, once ever), `add_ten`
(build args, queue the computation, per request), `add_ten_callback` (verify and
handle the result, called by the cluster).

The callback transaction is signed by an ordinary Arx node keypair and proves
nothing on its own. `verify_output` checks the cluster's BLS threshold signature
over the output; the program trusts that check and nothing else. It is the same
check that will authorize trades, which is why it was exercised on a toy first.

Quirk: `awaitComputationFinalization` returned a *later* transaction than the
one that actually succeeded — a duplicate callback attempt that failed with
`AlreadyCallbackedComputation` (6204). The successful callback was the earlier
`4n9nZAyk…`. Do not treat the returned signature as proof of success; assert on
the emitted event, as the test does.

### Registering a circuit is three steps, not one

`init_*_comp_def` (creates the definition account) → `uploadCircuit` (writes
circuit bytes into buffer accounts, chunked) → **finalize** (marks it usable).

Skip finalize and queueing fails with `ComputationDefinitionNotCompleted` (6300)
even though the account exists, `circuitLen` matches the file, and the buffer
reports `isCompleted: true` — those describe the *upload*, not the definition.
`getCircuitState(compDefAcc.circuitSource)` answers the real question
(`OnchainPending` vs `OnchainFinalized`). `uploadCircuit` returns early when
state is anything but `OnchainPending`, so re-running it after a partial upload
logs `skipped` and does nothing. Our own test had the matching bug: it skipped
`initAddTenCompDef` when the comp def account already existed, which also
skipped the upload. **Account existence is not circuit readiness.**

### Circuit uploads fail silently — verify them yourself

The costliest detour, and the first diagnosis was **wrong**, worth recording as
wrong: version skew was the guess, but every component was on 0.14.1 (`arcium`
CLI, `@arcium-hq/client`, `arcis`, `arcium-anchor` / `arcium-client`). Reading
the bytes settled it — the on-chain raw-circuit account held a **different
circuit than the one we compiled**:

```
local  build/add_ten.arcis   62,534 bytes  sha256 6d17f6b4…
onchain raw circuit acc 0    62,543 bytes  (9-byte header + payload)
        first differing byte at offset 814
        1,485 trailing bytes never written
```

814 is not a coincidence: `uploadCircuit` takes a **fixed 814-byte chunk** plus
an offset. Chunk 0 landed, later chunks did not — a rate-limited first upload
that died partway. Two things hid it:

1. **`isCompleted` is a flag, not a checksum.** `getCircuitState` returns
   `OnchainFinalized` from `circuitSource.onChain[0].isCompleted` and never
   compares stored bytes to anything. A half-written circuit reports finalized.
2. **`uploadCircuit` returns early unless state is `OnchainPending`**, so every
   later fix attempt logged `skipped` and did nothing.

So the cluster was faithfully fetching a corrupt circuit, failing to execute it
and aborting — as a detect-and-abort protocol should. Nothing was wrong with
Arcium, the cluster, or the callback wiring.

**The lesson: nothing on chain binds the stored circuit to the artifact you
built.** `build/add_ten.hash` exists locally (sha256 of the `.arcis`) but no
on-chain check uses it; verification is the integrator's job.
`tests/hello-arcium.ts` now reads the raw circuit account back after any upload
path and compares it byte for byte with the local artifact, failing with the
offset and chunk index if they differ. It paid off immediately: a network
timeout mid-upload corrupted the strategy read circuit at byte **105,012**
(chunk 129) — finalized, reporting `OnchainFinalized`, and different from the
local artifact. Caught on the spot instead of hours later as an unexplained
`verify_output` failure.

### Recovering from a corrupt upload, and why it may not work

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

Two waits, not one: buffers close after the definition's own TTL, but
`close-computation-definition` also fails with
`ComputationDefinitionHasActiveComputations` (6308) until every computation
queued against it has finalized or expired, each with its own 180-slot life.

**The second wait may not end.** On devnet it failed 24 consecutive times across
~12 minutes, long after the definition's own TTL was satisfied (6,213 slots
since deactivation against a 180-slot requirement). Decoding the cluster's
executing pool shows why: it is **shared across every MXE on the cluster** and
holds entries queued millions of slots ago, which an integrator cannot clear
from outside. The documented teardown path is therefore not reliably available
on a shared cluster. Two ways around it:

- **Rename the circuit** — the comp-def offset derives from the instruction
  name, so `add_ten` → `add_ten_v2` yields a fresh definition and skips teardown.
  Requires redeploying the program.
- **Use a local cluster**, where the pool is yours and disposable.

The rent is lopsided, which makes leaving a husk survivable: closing the
*buffers* returned 1.43 SOL of a 1.72 SOL registration, while the definition
account itself holds almost nothing. Take the buffer refund. And deactivate a
wrong definition even when you cannot close it — it stays queueable until
deactivated (here "wrong" meant sizing every sell against the quote balance).

### Changing a signature is not the same as changing bytes

Teardown swaps circuit *bytes* at the same offset. It does not help when the
parameter list changes: the interface is recorded in the definition's
`ComputationDefinitionMeta` at `init_computation_definition` and nothing
re-points it. Adding one parameter to `evaluate_strategy` needed a whole new
definition, and since an offset is `comp_def_offset(<circuit name>)`, a new
definition means a new *name* — `evaluate_strategy` became
`evaluate_strategy_v2`. The macros derive Rust identifiers from that name and
enforce it (callback `evaluate_strategy_v2_callback` inside
`EvaluateStrategyV2Callback`); the build tells you exactly what to rename.

### Program sizing: leave headroom or you cannot rename

A program that cannot grow cannot be redeployed, and a corrupt-circuit recovery
that needs a rename needs a redeploy. The deploys here allocated exactly the
binary size and later growth failed with `invalid program argument` — twice,
once at 32 bytes over (466,744 vs 466,712) and once at 16. That is what made the
rename route unavailable during the corrupt-upload recovery.

- **Do not pass `--max-len` on a program you may need to redeploy.** Sizing the
  data account to the exact binary halves the initial cost and then blocks every
  upgrade: fine for a disposable demo, wrong for the vault.
- **`solana program extend <program-id> <bytes>`** adds headroom afterwards.

### Why a separate program

`hello_arcium` holds the demo and the strategy instructions, deliberately
outside the vault: every instruction in a custody program is attack surface, so
Arcium wiring earns its way in once proven, and the demo stays deletable without
touching anything that holds funds. The circuits live in `encrypted-ixs/` and
move unchanged. The vault will need its own MXE deployment when evaluation is
wired to execution (a Phase 11 concern), because **the program that queues a
computation is the program that receives its callback.**

## 6. Source discrepancies, left visible

| Item | The disagreement | Handling |
|---|---|---|
| Program ID | Two devnet deployments recorded, never linked: `HVEKKMWwjLaQyXqkMGGshNGXa3Wm1PCSUnRaB6vAnB99` (MXE init `3z5eQp3H…`, key recovery `2uVEb4P9…`) and `FPZkMe1…` (the run in §1). | `Anchor.toml` declares `FPZkMe1…`, so §1 uses it; the earlier ID kept here, not dropped. |
| Deploy cost | One log: upgradeable reserves 2x the binary (~6.5 SOL here), `--max-len` gives 1x (~3.25 SOL) — yet its own table shows an upgradeable deploy without `--max-len` at 3.252991 SOL. Other log: `solana program deploy` allocates exactly the binary size. | Both stated. The 32-byte and 16-byte growth failures support exact-size allocation for the deploys actually made. |
| Read circuit name | One log calls the corrupted read circuit `read_strategy`; `encrypted-ixs/` and `build/` have `export_strategy`. | Called "the strategy read circuit"; offset and chunk index preserved. |
| Strategy fields | Four encrypted fields including `size_bps` here; the current circuit is `store_strategy_v2` with three. | Four kept as built, pointing at `../SECURITY.md` T-38. |
