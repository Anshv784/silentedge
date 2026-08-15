# Persistent confidential strategy state

A strategy encrypted to the MXE cluster, surviving between computations, with
the plaintext never existing outside the MPC.

**Status: working on Arcium devnet.** Stored, then read back in a *later*
computation, decrypting to exactly the four values that went in.

---

## Why the handover matters

The user's browser encrypts a strategy under a secret shared with the MXE:
`Enc<Shared, Strategy>`. That is the right shape for something they just typed —
they can read it back.

It is the wrong shape for a bot. Evaluation has to happen when the price moves,
not when the owner is at their laptop, and `Enc<Shared, _>` is bound to a key
the browser holds. So a computation re-encrypts it once:

```rust
#[instruction]
pub fn store_strategy(input: Enc<Shared, Strategy>) -> Enc<Mxe, Strategy> {
    let strategy = input.to_arcis();
    Mxe::get().from_arcis(strategy)
}
```

After this the stored bytes are readable only by the cluster acting together —
not by the program, not by the operator, and not by the owner's own browser.
That is what lets an unattended evaluation use the strategy later.

The plaintext exists only inside the MPC, secret-shared across nodes, for the
duration of that one computation.

## The shape it collapses into

```rust
pub struct Strategy {
    entry_below: u64,
    exit_above: u64,
    stop_below: u64,
    size_bps: u64,
}
```

Fixed, because Arcis compiles to circuits whose shape is known at compile time.
Prices are fixed-point with 6 decimals; `size_bps` is basis points of vault
value. A rule the user switched off is stored as a value whose comparison can
never be true (`0` for buy, `u64::MAX` for sell) rather than being absent — in
MPC both branches of a conditional execute regardless, so "off" has to be
indistinguishable from "on".

## Reading it back

```rust
#[instruction]
pub fn export_strategy(stored: Enc<Mxe, Strategy>, reader: Shared)
    -> Enc<Shared, Strategy>
```

**This circuit cannot tell who asked.** It re-encrypts to whatever x25519 key it
is handed, so anyone able to queue it could read the strategy. Authorization is
the Solana program's job:

```rust
#[account(
    seeds = [STORED_STRATEGY_SEED, payer.key().as_ref()],
    bump = stored_strategy.bump,
)]
pub stored_strategy: Account<'info, StoredStrategy>,
```

Seeded by the signer, so a different signer derives a different address and the
constraint rejects it. Worth stating plainly because it generalises: **a circuit
cannot authenticate a caller; only the chain can.** Every confidential
instruction needs its authorization written on the Solana side.

## What the test proves

`tests/strategy-state.ts`, against the live devnet cluster:

```
store queued: 3WrasjwVmEcYsJZfRzMuRouR…
read queued:  qr5babrxKkWV3mVYWQQB6NUF…
recovered: 150000000, 180500000, 120000000, 1000
✔ stores a strategy as MXE-encrypted state, then reads it back (42153ms)
```

Specifically:

1. The submitted ciphertext contains none of the four values (checked as
   little-endian u64 against the raw bytes).
2. After the store computation, the on-chain `StoredStrategy` account contains
   none of them either, as bytes or as decimal text.
3. The account carries **no client encryption key** — `Enc<Mxe, _>` has no shared
   secret, so the submitter's own key is useless against it.
4. A **second, later** computation — different nonce, different ephemeral key —
   reads that state and returns it re-encrypted, decrypting to exactly what went
   in.

Point 4 is the one that matters. State written by one computation is intact and
usable by another.

## Circuit cost

| Circuit | Gates | Depth | Network size |
|---------|------:|------:|-------------:|
| `add_ten` (1 field) | 9,075 | 54 | 236,012 |
| `store_strategy` (4 fields) | 20,921 | 54 | 350,256 |
| `export_strategy` (4 fields) | 20,260 | 54 | 348,080 |

Depth is **identical** across all three. Going from one encrypted value to four
roughly doubles the gate count and leaves depth untouched — the cost is the
encryption envelope widening, not the logic deepening.

The practical consequence for the strategy engine: evaluating the whole strategy
in a single computation will cost barely more than these do, while splitting it
across several would pay the envelope each time. Do it in one.

## Latency

**~42 s** for the pair of computations (store, then read) end to end on devnet,
against ~11.6 s for a single `add_ten`. Consistent with roughly 15–20 s per
computation including queueing, on a shared cluster.

Still firmly in the seconds range that shaped the product's positioning. The
strategy engine needs one computation per evaluation, not two — the store
happens once when the strategy is set.

## Where this lives, and where it goes

These instructions are in `programs/hello_arcium`, not the vault. The vault is a
custody program and every instruction in it is attack surface; Arcium wiring
earns its way in once proven, not before. The circuits themselves live in
`encrypted-ixs/` and move unchanged.

The vault will need its own MXE deployment when evaluation is wired to
execution, because the program that queues a computation is the program that
receives its callback. That is a Phase 11 concern.

## Operational notes

**Circuit uploads fail silently and must be verified.** A network timeout
mid-upload corrupted `read_strategy` here — finalized, reported
`OnchainFinalized`, and differed from the local artifact at byte 105,012
(chunk 129). The byte-comparison check added after the Phase 7 incident caught
it immediately. Always verify; see
[`arcium-hello-world.md`](arcium-hello-world.md).

**`solana program deploy` allocates exactly the binary size.** Any later growth
then fails with `invalid program argument`. This bit twice — once at 32 bytes
over, once at 16. The fix is `solana program extend <program-id> <bytes>` to add
headroom; a corrupt-circuit recovery that needs a rename needs a redeploy, and a
program that cannot grow cannot be redeployed.
