# hello_arcium — archived, not deleted

The first working Arcium integration in this project: the smallest real
computation (`add_ten`) and a strategy round-trip, proven end to end on the
devnet cluster. The write-up is in [`docs/arcium.md`](../../docs/arcium.md) and
it is the reason the vault's own MPC path could be built with any confidence.

**It no longer compiles, and that is expected.** Its `store_strategy` and
`evaluate_strategy` paths drive circuits that were superseded by the `_v2` and
`_v3` versions in `encrypted-ixs/`. The most visible drift is the strategy field
count: this program assumes four encrypted fields, while the live `Strategy`
carries three, because `size_bps` is public by design (SECURITY.md, T-38).

It is kept because it is the record of how the Arcium pipeline was actually
made to work, which is genuinely useful to anyone building on Arcium. It was
moved out of `programs/` because while it sat there it was a Cargo workspace
member and an Anchor build target, so a single stale constant inside dead code
broke `arcium build` for the whole repository — including the vault, which is
the program that matters.

Its test suite moved here too (`hello-arcium.test.ts`). It belonged to no npm
script — `test:pure`, `test:local`, `test:devnet` and `test:fork` all name their
files explicitly — so it only ran under the bare `npm test` glob, against a
program that no longer builds.

To revive it, update it against the current circuits in `encrypted-ixs/src/lib.rs`
and move it back under `programs/`.
