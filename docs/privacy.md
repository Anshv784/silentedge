# What is private, and what is not

"Private" is not a property a system has. It is a set of claims about specific
data against specific observers, and each one is either true or a liability.
This is the whole set, with the evidence. No third party has reviewed any of it.

## Evidence, on devnet

| Test | Asserts |
|---|---|
| `e2e-devnet.ts` — *stores a strategy the program cannot read* | plaintext `entry_below` bytes appear nowhere in the stored `StrategyState`; not armed until converted |
| `e2e-devnet.ts` — *bounded authorization from a verified callback* | BUY intent written only by a BLS-verified callback, sized from the public `size_bps`, bound to vault nonce and strategy version, expiring inside 180 slots |
| `trade-authorization-devnet.ts` | every branch: HOLD touches no intent; BUY; take-profit SELL sized from the **base** balance; stop-loss SELL for the **whole** position |
| `encryption.ts` (pure) | exactly three ciphertexts; no plaintext threshold in the ciphertext bytes in either endianness; `size_bps` absent from the payload |

The first three run against the live Arcium devnet cluster —
`npm run test:devnet`, `npm run test:pure`, see [`testing.md`](testing.md).

**Citation correction.** Earlier versions cited `tests/strategy-engine.ts` and a
worked example from it (BUY at 140, HOLD at 165, take-profit at 190, stop at
110; ~5–7 s per evaluation). **Those numbers are historical.** That file drove
`HelloArcium` and an `evaluate_strategy` taking vault value as a *caller
argument*, the interface the current design removed, so it could not run and was
deleted (SECURITY_AUDIT finding 5); its two unique branches were ported to
`trade-authorization-devnet.ts`. One lesson survives: its privacy assertion
searched `JSON.stringify(tx)`, where instruction data is base58-encoded, so the
negative assertions passed and would have passed identically had the thresholds
been there. A positive control ("the public price should be present") caught it.
**A privacy assertion without a positive control only tests its own encoding.**
Current checks read raw account and ciphertext bytes.

## Per-field visibility

`evaluate_strategy(strategy_ctxt: Enc<Mxe, Strategy>, price: u64, vault_value:
u64) -> (u8, u64)` — one encrypted argument, two public ones, two revealed
outputs.

| Field | Class | Note |
|---|---|---|
| `entry_below`, `exit_above`, `stop_below` | **encrypted** | the entire secret: three numbers. Stored `Enc<Mxe, _>`; the submitted copy also reads under the owner's derived key, nobody else's |
| intermediate comparisons, distance past a threshold | **encrypted** | secret-shared, never materialised, not returned |
| `price`, `vault_value` | public | plaintext args — encrypting a public price and a public token balance costs gates and hides nothing |
| `action`, `amount` | public | revealed in the callback |
| `size_bps` and every other risk limit | public | deliberately; leak 1 |
| vault address, owner, mints, balances, status, nonce, last trade; strategy ciphertext and version | public | ordinary accounts |
| every authorization and trade — side, amount, expiry, decision price; that an evaluation happened, for which vault, whether it traded | public | on chain forever |
| the thresholds, after enough observed trades | **inferable** | public in effect, not in storage; leak 3 |
| the pre-encryption draft | never on chain | tab memory only: no `localStorage`, cookies, logging, or request carrying it; CSP `connect-src` bounds where a script could send it. **T-15 UNVERIFIED** — rests on frontend integrity, no test fails if the guard is removed |
| the user's encryption key; private keys of any kind | never on chain | the key is derived from a wallet signature on demand and never stored; no instruction accepts a private key |

**A strategy is unread, not unknowable.**

**Revealed by asking**, which no on-chain control covers: requesting a swap
route tells the router your intended trade. The browser self-execute path and
the executor both call Jupiter's public API with input mint, output mint,
amount, and the vault as `taker`, disclosing a pending trade before submission.
Inherent to using a router, outside the MPC, not private. The RPC endpoint also
sees every account the app reads, identifying the wallet to that provider.

## Who sees what

Privacy holds under Arcium's dishonest-majority model while **at least one** Arx
node is honest, even if every other node colludes.

| Observer | Sees |
|---|---|
| **A chain observer** | every account and transaction this program touches; every `(price, vault_value, action, amount)` tuple, forever |
| **One Arx node**, or **n−1 colluding** | the public inputs, its own shares (meaningless alone), the revealed output. Shares short of the full set reveal nothing |
| **All n nodes colluding** | everything, including the plaintext strategy. The assumption the design rests on and the one it cannot defend (T-11) |
| **The operator** | the chain view, plus browser traffic, timing, which vault asked for which route, what the executor pays for — plus the MXE authority below |
| **The owner** | the above for their own vault, plus their own draft before encryption |

**The operator holds the MXE authority (T-7).** It *permits* migrating the MXE
to an operator-controlled cluster — a documented, supported Arcium feature —
reconstructing key material, and decrypting strategy ciphertext already
published on chain. Inherent: anything the MXE computes on, the MXE key
decrypts, and on-chain data is permanent. Nothing transfers, burns, or timelocks
the authority, and Recovery Peers have no documented veto. It does *not* permit
forging trade authorizations: `cluster_account` is pinned to a compiled-in
constant, so attestations from any other cluster are rejected and a migration
halts every bot loudly and publicly. Nor does it move funds, subject to T-3.
Treat operator-level strategy confidentiality as trust-based, not enforced.

## Where the boundary is enforced

Not in the UI. Hiding a value in the frontend is a presentation choice.

| Claim | Enforced by | Grade |
|---|---|---|
| the operator cannot read a strategy | transmitted only as ciphertext; the key is the cluster's | DESIGN (T-8) |
| a single node cannot read a strategy | Arcium's secret sharing — a vendor property, reproduced here, **not verified here** | **UNVERIFIED (T-10)** |
| the program cannot read a strategy | stores opaque bytes; no instruction interprets them | `e2e-devnet.ts` |
| no instruction in the deployed program accepts an operator authority | `withdraw` requires the `owner` signature and sends only to `owner`; destination is not a parameter | ENFORCED (T-1), `vault.ts` |
| a follower cannot read a leader's strategy | no instruction exports strategy plaintext | DESIGN |

**Every custody claim above is conditional on T-3, graded UNVERIFIED.** The
program upgrade authority is a single hot key today — the deployer keypair. No
in-program fix exists. Non-custodial is true of the deployed code, not of future
code. It must become a timelocked multisig before mainnet.

## What leaks anyway

Better cryptography fixes none of this.

**1. `size_bps` was recoverable from one trade, so it is no longer encrypted
(T-38, closed).** `amount = vault_value × size_bps / 10_000`, `vault_value`
public in the same transaction, `amount` revealed — one non-HOLD evaluation
disclosed it exactly. It moved to `RiskLimits.size_bps`: public, owner-editable.
Three encrypted integers now, not four, asserted by two tests. Encrypting it
implied a protection one trade destroys, which is worse than storing it in the
clear. The evaluate circuit halved, 246,850 → 114,762 bytes.

**2. The amount distinguishes a stop from a take-profit (T-39).** A stop exits
the whole position (`amount == vault_value`); a take-profit trades the
configured fraction. Both return `action = 2`, so an observer learns which sell
rule fired, and so whether price sat below `stop_below` or above `exit_above`.
Inherent to "a stop is a full exit"; sizing them identically changes what the
product does.

**3. Thresholds narrow by bisection (T-9).** Each evaluation is a public
`(price, action)` pair, and each pair is an inequality:

| Action | What it says |
|---|---|
| `HOLD` | `stop_below ≤ price`, `entry_below ≤ price`, `price ≤ exit_above` |
| `BUY` | `price < entry_below` |
| `SELL`, partial amount | `price > exit_above` |
| `SELL`, full amount | `price < stop_below` |

Enough of these across a moving market squeeze every threshold between tight
bounds. MPC does not prevent it: the information is in the *decisions*, which
must be public to be executed. Bounds tighten roughly logarithmically in the
number of evaluations straddling a threshold — an active bot in a ranging market
gives its thresholds up to a determined observer in days, not years. **Nothing
mitigates this today.**

**4. Timing does not leak, and that is not an accident (T-12).** Both branches
of every conditional execute regardless of outcome, so a BUY costs what a HOLD
costs and takes the same time. A rule switched off is a sentinel that can never
match rather than a skipped branch, so "off" is indistinguishable from "on".
Arcis also refuses `.reveal()` inside a non-constant conditional, which stops
control flow leaking through the output shape.

**Mitigations, none of them implemented** — all V2 candidates, and none a fix.
They change the cost of inference, not its possibility.

| Mitigation | Effect | Limit |
|---|---|---|
| Jittered evaluation cadence | slows bisection, decorrelates from price feeds | does not change what a decision implies |
| Randomised size (`ArcisRNG`) | blurs the size derivation | only if noise exceeds the quantum an observer can measure |
| Quantised amounts | coarsens leaks 1 and 2 | costs execution precision |
| Threshold bands instead of points | widens the inferred interval | changes strategy semantics |
| Fewer, larger trades | fewer observations | opposed to what many strategies want |

## The honest claim

> Your thresholds are never transmitted, stored, or computed in the clear. They
> are secret-shared across a cluster and stay private as long as one node is
> honest. But your **trades are public**, and a trade is a decision — enough of
> them will narrow your thresholds. Your trade size is recoverable from a single
> trade.

Never claimed: that a strategy cannot be seen at all (decisions are visible by
construction); that nobody can figure one out (a patient observer bounds it);
that all four parameters are secret (three, and `size_bps` is public config,
because pretending otherwise was the problem); that trades are private; that
thresholds stay secret indefinitely; that the cluster cannot read the strategy
(it can, by construction — that is what lets it evaluate one; the claim is about
*single* parties); that the operator has no advantage.

Without MPC the operator reads your thresholds directly, acts on every trade
before it happens, and copies the strategy wholesale. With it, nobody sees a
threshold before you act on it, and an observer can only reason backwards from
executed trades. That gap — knowing a strategy versus inferring it from
behaviour — is real and valuable, and it is not concealment.

## Related

- [`SECURITY.md`](../SECURITY.md) — T-9, T-7, T-3, T-38, T-39
- [`SECURITY.md`](../SECURITY.md) — the grade behind each control
- [`arcium.md`](arcium.md) — how the state is held
- [`arcium.md`](arcium.md) — the confidentiality model on a toy
