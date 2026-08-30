# The price oracle

Where the number that decides a trade comes from, and why it is not the obvious
one.

---

## Pyth triggers, Jupiter quotes

They answer different questions and are not interchangeable:

| Question | Source | Why |
|----------|--------|-----|
| **Should I trade?** | **Pyth** | Signed, aggregated across publishers, carries a confidence interval, and cannot be moved by trading |
| **What will I get?** | **Jupiter** | The actual executable price including route and impact |
| **Was that execution sane?** | **Pyth**, checked on chain | An independent reference to bound the fill against |

Using a DEX quote as the trigger would be a serious vulnerability rather than a
simplification. A pool price is a function of trade flow: anyone can push it by
trading into it. If a stop-loss fired on a DEX quote, an attacker could shove
the pool through a victim's stop, take the other side of the forced sale, and
let the price revert. They would be paying spread to mint someone else's stop
order.

Pyth's aggregate does not move that way. Moving it means corrupting a majority
of publishers, not spending money in one pool.

The inverse holds too: an oracle price is not executable. It is a reference, not
a quote, and sizing a swap off it without a route would guarantee slippage
surprises. Hence the split — and hence the on-chain deviation check between them
when the trade executes.

## What changed in Phase 10

`evaluate_strategy` used to take `price: u64` as an argument. The instruction is
permissionless, so **anyone could name any price** and drive someone else's
strategy to whatever decision they wanted. Fine for exercising a circuit;
unacceptable for money.

The price is now read on chain from a Pyth `PriceUpdateV2` account. The caller
supplies the account, not the number, and every property of that account is
checked before the number is used.

## Validation

All in `programs/hello_arcium/src/oracle.rs`. Every failure is a refusal to
trade, never a fallback to a default — **a bot that trades on a bad price is
worse than a bot that does not trade.**

| Check | Rule | Rationale |
|-------|------|-----------|
| Authenticity | `Account<PriceUpdateV2>` | Anchor enforces ownership by the Pyth receiver, which has already verified the Wormhole attestation |
| Right feed | `get_price_no_older_than(.., &feed_id)` | Fails on any other feed, so a cheap or manipulable feed cannot be substituted |
| Freshness | ≤ **30 s** | Pyth's own guidance: never build a flow that depends on winning a race against an adversary posting an update |
| Confidence | ≤ **100 bps** | Pyth widens confidence when publishers disagree or liquidity thins — exactly when one number is least trustworthy |
| Positive | `price > 0` | A non-positive price is a broken feed, not a market |
| Sanity band | **$1 – $10,000** | A tripwire for a feed wrong in a way staleness and confidence would not catch |
| Exponent | `-38 ≤ expo + 6 ≤ 38` | Guards the scaling arithmetic against a nonsense exponent |
| Scaling | checked throughout | Overflow refuses rather than wraps |

### On refusing rather than widening

Pyth's docs suggest widening spreads when confidence grows. That fits a market
maker quoting continuously. This system makes discrete decisions, so there is no
spread to widen — the equivalent is simply not to act. Refusing is simpler,
strictly safer, and fails in the direction that costs nothing.

### Scaling

Pyth reports `value × 10^exponent`; the system works in 6-decimal fixed point.
SOL/USD publishes at `exponent = -8`, so the usual path divides by 100 — but the
exponent belongs to the feed and can change, so both directions are handled
rather than assumed. Truncation loses at most one unit in the sixth decimal,
far inside the 1% confidence bound already required.

## Verified against the live feed

Pyth's sponsored SOL/USD account on devnet,
`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`:

```
owner   : rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
feed_id : ef0d8b6f…c280b56d   (SOL/USD)
price   : 7554404325  expo -8   →  $75.54404325
conf    : 6.2 bps
age     : 16 s
```

Because the price is read on chain, **the tests can no longer choose it.** Each
scenario stores a strategy whose thresholds are positioned around whatever SOL
is worth at that moment and asserts the decision that follows. A test that could
pick the price would not be testing this path at all.

## Still open

**`vault_value` is still a caller-supplied argument.** It scales the trade size,
so a caller can inflate it. Closing it requires the program to read the vault's
own token accounts — which means the vault program owns this instruction. That
is Phase 11, when evaluation is wired to execution.

Worth being explicit: Phase 10 removed one of the two ways a caller could steer
someone else's bot. The other is still open, and the system is not safe for real
money until it is closed.

**Per-direction confidence bounds.** Pyth's stricter pattern is to use the lower
bound when a low price favours you and the upper when a high one does — for a
strategy engine, the upper bound when testing a buy threshold and the lower when
testing a sell. The current code uses the aggregate and enforces a tight
confidence bound instead, which at ≤1% keeps the difference small. Passing both
bounds means a new circuit signature; worth doing before mainnet, not worth a
redeploy now.

## An Anchor constraint worth knowing

**A program may declare exactly one `#[error_code]` enum.** Putting the oracle's
errors in their own enum compiled fine and produced a working `.so` — then
`anchor build` failed at IDL generation with `Multiple error definitions are not
allowed`.

The failure mode is nastier than the message suggests: the program deploys and
runs, but the IDL is silently left at its previous version, so the TypeScript
client builds calls against a stale instruction signature. The visible symptom
was `Account 'payer' not provided` — nothing to do with payers, everything to do
with the client and the program disagreeing about what the instruction takes.

Two lessons: keep one error enum per program, and treat a stale IDL as a
first-class suspect when a client-side call fails for reasons that make no sense.

## Related

- [`research.md`](research.md) §5 — Pyth research and the trigger/quote split
- [`SECURITY.md`](../SECURITY.md) — T-24 stale price, T-25 wide confidence, T-26 DEX manipulation
