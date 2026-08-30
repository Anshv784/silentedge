# Committed IDL

`anchor build` writes the program's IDL and TypeScript types into `target/`,
which is gitignored — so on a fresh clone both the web app and the executor
imported a file that was not there, and neither would start.

These are copies, committed so the repository runs without a Rust toolchain.
They are generated artifacts: regenerate with `anchor build` and copy them back
whenever the program's interface changes.

    anchor build
    cp target/idl/vault.json  idl/vault.json
    cp target/types/vault.ts  idl/vault.ts

`tests/wiring.ts` asserts the committed copy matches the program's declared
address, so a stale IDL fails the default test run rather than failing at
runtime in front of a user.
