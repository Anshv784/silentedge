# What is visible, to whom

A precise classification, because "private" is not a property a system has — it
is a set of claims about specific data against specific observers, and every one
of those claims is either true or a liability.

This is the operational companion to [`what-is-private.md`](what-is-private.md),
which covers the inference problem in depth.

## The observers

| | who they are | what they can see |
|---|---|---|
| **Anyone** | a stranger reading the chain | every account and transaction this program touches |
| **The operator** | whoever runs the frontend and executor | everything "anyone" sees, plus what the browser sends and what the executor pays for |
| **An Arx node** | one of the MPC cluster's nodes | its own secret shares, and every plaintext argument to a computation |
| **The whole cluster** | all Arx nodes colluding | the strategy plaintext. This is the assumption the design rests on and the one it cannot defend |
| **The owner** | the wallet that created the vault | everything above about their own vault, plus their own draft before it is encrypted |

## The data

### Public — on chain, by design

Anyone can read these. None of it is hidden and none of it should be described
as private.

- The vault address, its owner, both mints, and both token balances.
- Every risk limit, including `size_bps`. This is deliberate:
  `amount = balance × size_bps / 10_000`, and both the amount and the balance
  are public in the same transaction, so encrypting it would have implied a
  protection that one trade destroys (THREAT_MODEL T-38).
- Vault status, nonce, and the time of the last trade.
- Every authorization: side, amount, expiry, and the price it was decided at.
- Every trade: what was swapped, for how much, and when.
- The *fact* that an evaluation happened, and whether it produced a trade.

### Encrypted — on chain, unreadable

Stored publicly as ciphertext. Readable only by the MPC cluster acting together.

- `entry_below`, `exit_above`, `stop_below` — the three price thresholds.

That is the entire secret. It is three numbers, and the claim about them is
narrow: no single party, including the operator and any individual node, can
read them.

### Inferable — public in effect, not in storage

The thresholds are encrypted and still leak, slowly, through behaviour. This is
the most important row in this document because it is the one users get wrong.

- Each evaluation is a public `(price, action)` pair, and each pair is an
  inequality about a threshold. Enough of them bracket it tightly.
- A full-position exit is distinguishable from a partial take-profit, so a sell
  reveals *which* rule fired (THREAT_MODEL T-39).
- Nothing mitigates this today. Jittered timing and randomised sizing are V2
  candidates and are not implemented.

**A strategy is unread, not unknowable.**

### Never on chain

- The draft strategy before encryption. It exists only in the tab's memory: no
  `localStorage`, no cookies, no logging, and no network request carries it —
  audited, and the CSP's `connect-src` bounds where anything could be sent even
  if a script tried.
- The user's encryption key, which is derived from a wallet signature on demand
  and never stored.
- Private keys of any kind. The program has no instruction that accepts one.

### Revealed by asking

Worth stating because it is easy to miss and no on-chain control covers it:

- **Requesting a swap route tells the router your intended trade.** Both the
  browser's self-execute path and the executor call Jupiter's public API with
  the input mint, output mint, amount, and the vault as `taker`. That discloses
  a pending trade to Jupiter before it is submitted. It is inherent to using a
  router, it is not covered by the MPC, and it should not be described as
  private.
- The RPC endpoint sees every account this app reads, which identifies the
  wallet to that provider.

## Where the boundary is actually enforced

Not in the UI. The frontend hiding a value is a presentation choice; these are
the enforcement points:

| claim | enforced by |
|---|---|
| the operator cannot read a strategy | it is only ever transmitted as ciphertext, and the key is the cluster's |
| a single node cannot read a strategy | Arcium's secret sharing — a vendor property, reproduced, not verified here |
| the program cannot read a strategy | it stores opaque bytes and has no instruction that interprets them |
| the operator cannot move funds | no instruction accepts an operator authority (T-1) |
| a follower cannot read a leader's strategy | no instruction exports strategy plaintext to anyone |

## What this does not claim

- Not that trades are private. They are public.
- Not that thresholds stay secret indefinitely. They narrow with every trade.
- Not that the cluster cannot read the strategy. It can, by construction —
  that is what lets it evaluate one. The claim is about *single* parties.
- Not that the operator has no advantage. They see traffic, timing, and which
  vault asked for which route.
