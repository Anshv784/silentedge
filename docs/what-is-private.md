# What is actually private

A precise account of what the confidential strategy engine hides, what it does
not, and what an observer can reconstruct anyway.

Written because "the strategy is encrypted" is not a security claim. The
encryption works; the question is what survives contact with a public chain.

---

## Verified on devnet

`tests/strategy-engine.ts`, against the live Arcium devnet cluster, with
`entry_below = 150`, `exit_above = 180.50`, `stop_below = 120`, `size_bps = 1000`
and a vault worth 2,500 USDC:

| Price | Action | Amount | Meaning |
|------:|:------:|-------:|---------|
| 140 | 1 (BUY) | 250.000000 | below entry, 10% of vault |
| 165 | 0 (HOLD) | 0 | between thresholds |
| 190 | 2 (SELL) | 250.000000 | above exit, 10% of vault |
| 110 | 2 (SELL) | 2,500.000000 | below stop, whole position |

Five tests, 36 s total, roughly 5–7 s per evaluation. The fifth asserts that no
threshold appears in the evaluation transaction's **serialized message bytes**.

That distinction was earned the hard way: the first version searched
`JSON.stringify(tx)`, where instruction data is base58-encoded. The negative
assertions all passed — and would have passed identically if the thresholds
*had* been there. A deliberate positive control ("the public price should be
present") failed and exposed it. **Any privacy assertion needs a positive
control, or it is only testing its own encoding.**

## The computation

```rust
#[instruction]
pub fn evaluate_strategy(
    strategy_ctxt: Enc<Mxe, Strategy>,   // secret
    price: u64,                          // public
    vault_value: u64,                    // public
) -> (u8, u64)                           // revealed: action, amount
```

## Private

Under Arcium's dishonest-majority model — privacy holds while **at least one**
Arx node is honest, even if every other node colludes:

| Value | Status |
|-------|--------|
| `entry_below`, `exit_above`, `stop_below` | Never leave the MPC in plaintext |
| The stored strategy at rest | `Enc<Mxe, _>` — no client key exists for it |
| Intermediate comparison results | Secret-shared; never materialised anywhere |
| How far past a threshold the price sat | Not returned |

## Public

| Value | Where |
|-------|-------|
| `price`, `vault_value` | Plaintext instruction args, visible on chain and to every node |
| `action` (0/1/2), `amount` | Revealed in the callback |
| That an evaluation happened, when, for which vault | Transaction history |
| Strategy ciphertext and its version | The stored account |

`price` and `vault_value` are public deliberately. The price is public
information and the vault balance is a public token account — encrypting them
would cost gates and hide nothing.

## What each observer sees

| Observer | Sees |
|----------|------|
| **One Arx node** | The public inputs, its own secret shares (meaningless alone), the revealed output |
| **n−1 colluding nodes** | The same. Dishonest-majority: shares short of the full set reveal nothing |
| **All n nodes colluding** | Everything, including the plaintext strategy. This is the assumption, and it is an assumption |
| **A chain observer** | Every `(price, vault_value, action, amount)` tuple, forever |
| **The operator** | The chain observer's view, plus the MXE authority problem in THREAT_MODEL T-7 |

## What leaks anyway

This is the part that matters, and it is not fixed by better cryptography.

### 1. `size_bps` is fully recoverable — not partially, completely

```
amount = vault_value × size_bps / 10_000
```

`vault_value` is public in the same transaction, and `amount` is revealed. So
**one non-HOLD evaluation discloses `size_bps` exactly.** One of the four
"secret" fields is not secret after a single trade.

**Recommendation:** move `size_bps` out of the encrypted struct and into public
vault config. Keeping it encrypted implies a protection that does not exist, and
that is worse than storing it in the clear. Deferred rather than done because it
changes the `Strategy` shape everywhere; it should land before mainnet.

### 2. The amount distinguishes a stop from a take-profit

A stop exits the whole position (`amount == vault_value`); a take-profit trades
the configured fraction. Both return `action = 2`, but the amounts differ, so an
observer can tell **which sell rule fired** — and therefore whether the price
sat below `stop_below` or above `exit_above`.

Inherent to "a stop is a full exit". Making the two indistinguishable would mean
sizing them identically, which changes what the product does.

### 3. Thresholds narrow by bisection

Each evaluation yields a `(price, action)` pair and each pair is an inequality:

| Action | What it says |
|--------|--------------|
| `HOLD` | `stop_below ≤ price`, `entry_below ≤ price`, `price ≤ exit_above` |
| `BUY` | `price < entry_below` |
| `SELL`, partial amount | `price > exit_above` |
| `SELL`, full amount | `price < stop_below` |

Collect enough of these across a moving market and each threshold is squeezed
between its tightest bounds. Nothing about MPC prevents this: the information is
in the *decisions*, which have to be public to be executed.

**How fast?** Bounds tighten roughly logarithmically in the number of
evaluations that straddle a threshold. A bot evaluating often in a ranging
market gives up its thresholds to a determined observer within days, not years.

### 4. Timing does not leak, and that is not an accident

Both branches of every conditional execute in MPC regardless of the outcome, so
a BUY costs exactly what a HOLD costs and takes the same time. A rule the user
switched off is a sentinel that can never match rather than a skipped branch, so
"off" is indistinguishable from "on". Arcis also refuses `.reveal()` inside a
non-constant conditional, which is what stops control flow leaking through the
output shape.

This is one of the few places where the MPC model gives a side-channel property
for free.

## Mitigations, and their limits

| Mitigation | Effect | Limit |
|------------|--------|-------|
| Jittered evaluation cadence | Slows bisection, decorrelates from price feeds | Does not change what a decision implies |
| Randomised size (`ArcisRNG`) | Blurs the `size_bps` derivation | Only if the noise exceeds the quantum an observer can measure |
| Quantised amounts | Coarsens leaks 1 and 2 | Costs execution precision |
| Threshold bands instead of points | Widens the inferred interval | Changes strategy semantics |
| Fewer, larger trades | Fewer observations | Directly opposed to what many strategies want |

None of these is a fix. They change the cost of inference, not its possibility.

## The honest claim

> Your thresholds are never transmitted, stored, or computed in the clear. They
> are secret-shared across a cluster and stay private as long as one node is
> honest. But your **trades are public**, and a trade is a decision — enough of
> them will narrow your thresholds. Your trade size is recoverable from a single
> trade.

What we must not say:

- ~~"Your strategy is invisible"~~ — the decisions are visible by construction.
- ~~"Nobody can figure out your strategy"~~ — a patient observer can bound it.
- ~~"All four parameters are secret"~~ — `size_bps` is not, in practice.

## Where this differs from the naive expectation

A reasonable person assumes encrypting a strategy hides it. What encryption
actually buys here is narrower and worth stating exactly:

- **Without MPC:** the operator reads your thresholds directly, can front-run
  every trade before it happens, and can copy the strategy wholesale.
- **With MPC:** nobody sees a threshold before you act on it. An observer can
  only reason backwards from trades that have already executed.

The difference is between *knowing your strategy* and *inferring it from your
behaviour*. That is a real and valuable difference. It is not invisibility.

## Related

- [`THREAT_MODEL.md`](../THREAT_MODEL.md) — T-9 (threshold inference), T-7 (MXE authority)
- [`persistent-strategy-state.md`](persistent-strategy-state.md) — how the state is held
- [`arcium-hello-world.md`](arcium-hello-world.md) — the confidentiality model on a toy
