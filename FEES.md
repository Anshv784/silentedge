# Fees

What this charges, what it does not, and who actually pays for the parts that
cost money.

## SilentEdge charges no protocol fee

There is no instruction in the program that transfers value to an operator, a
treasury, or any address other than the vault's own owner. That is not a pricing
decision that could be reversed in a config file — it is a property of the
instruction set, and the same property that makes the custody claim true:

> Funds leave a vault by exactly two paths: a swap between the vault's own two
> token accounts, and a withdrawal to `VaultConfig.owner`.

A protocol fee would add a third path. That is worth stating plainly because it
is the reason one has not been added quietly: any fee mechanism is, structurally,
a way for someone other than the owner to move money out of the vault, and every
security claim in [`SECURITY.md`](SECURITY.md) would need re-reading
against it.

## What does cost money, and who pays it

Running this is not free. Being specific about where the cost falls:

| cost | paid by | roughly |
|---|---|---|
| Vault creation (account rent) | the vault owner, once | ~0.002 SOL, recoverable only by closing, which the program cannot do today |
| Deposit / withdraw transaction fees | the vault owner | ~0.000005 SOL each |
| Strategy submission and conversion | the vault owner | two transactions, plus one Arcium computation |
| **Each strategy evaluation** | **whoever submits it** | one transaction plus an Arcium computation fee |
| **Each trade execution** | **whoever submits it** | one transaction; the swap's own costs come out of the trade |
| Swap spread, price impact, and Jupiter routing | the vault, out of the trade | bounded by `max_slippage_bps` and the oracle-derived floor |

The two rows in bold are the interesting ones. `evaluate_strategy` and
`execute_trade` are both permissionless — anyone may submit them and the payer
holds no privilege — so in practice they are paid by whoever runs an executor.
Today that is the operator, out of pocket, and there is no mechanism by which
they are reimbursed.

That arrangement does not scale, and pretending otherwise would be the dishonest
part. It is fine for devnet and for a small number of vaults; it is not a
business model. See "If a fee is added" below.

## The cost that is easy to miss

The largest real cost of trading here is not a fee at all — it is the swap. A
fill can land anywhere between the oracle-derived floor and a perfect price, and
the difference is kept by whoever routed it. `max_slippage_bps` is the entire
bound on that, it is the vault owner's own setting, and it is charged on every
trade whether or not anyone calls it a fee.

Set it as tight as your strategy tolerates.

## If a fee is added

Two designs are plausible and neither has been built:

**A protocol fee on trade output.** A fixed share of what a swap delivers, sent
to a pinned treasury. It would need: a compiled-in treasury address (so it
cannot be redirected without a public program upgrade), a compiled-in ceiling
independent of any per-vault setting, charging only on successful trades, and an
explicit rewrite of the custody invariant above. It also needs a treasury
address that a person has decided on — inventing one would be worse than having
no fee.

**A performance fee to a followed strategy's author.** The natural fee for
copy-trading, and currently not computable: it requires a cost basis, and the
vault deliberately keeps none (see `daily_loss_limit_bps` in
[`SECURITY.md`](SECURITY.md) T-31 for why estimating one was
rejected). Building it means building cost-basis accounting first, and doing
that properly means pricing deposits and withdrawals — which puts the oracle on
the withdraw path, which is the one thing that must keep working when everything
else is down.

Both designs are blocked on the same input the code cannot supply — a treasury
address, which only whoever owns this project can decide — and because a fee is
structurally a third way for value to leave a vault, alongside the swap and the
vault owner's withdrawal, that decision was left open rather than taken quietly.

Until one of those is deliberately chosen, implemented, and audited, the honest
answer is the one at the top: no protocol fee, and the operator absorbs the
running cost.

## Disclosure

The application states this on the vault screen rather than in a footer. If you
ever see a fee described in the interface that is not documented here, treat the
interface as wrong and check the program.
