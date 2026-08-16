# Things that need you

Short on purpose. Everything not on this list was done without you.

---

## 1. The upgrade authority is a single hot key — BLOCKS MAINNET

**Phase:** carried since the security audit (T-3), unresolved and unresolvable
from inside the repo.

**The blocker.** `solana program show J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ`
reports the upgrade authority as `Cbdvwy6Dm7tbCsLP3nw4Umz29BLNQkNwCBDDDRrkbpTZ`,
and that account is system-owned — a plain keypair, not a multisig. Whoever holds
it can replace `withdraw` with a version that pays an operator.

**Why every other security claim depends on it.** The audit's findings are all
statements about the *deployed bytecode*. A hot upgrade authority means they are
not statements about tomorrow's bytecode. Until it moves, "non-custodial"
describes the code that is running and not the project.

**Why I cannot do it.** Creating a Squads multisig means signing transactions
from your wallet and deciding who the signers are and what the threshold is.
That is an ownership decision, not an engineering one, and it is irreversible in
the direction that matters.

**What to do**

1. Create a Squads multisig (https://squads.so) with signers you control.
2. Transfer the authority:
   ```
   solana program set-upgrade-authority J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ \
     --new-upgrade-authority <MULTISIG_PDA>
   ```
3. Verify — this is already built and currently exits 1:
   ```
   node scripts/check-upgrade-authority.mjs \
     --rpc "$DEVNET_RPC" --expect <MULTISIG_PDA>
   ```
   Wire that command into any deploy pipeline. It refuses to pass while the
   authority is a plain keypair, which is the state today.

---

## 2. Decide whether there is a protocol fee — BLOCKS A BUSINESS MODEL, NOT THE MVP

**Phase:** 25.

**The blocker.** There is no fee, and I did not add one. Every fee mechanism is
structurally a third way for value to leave a vault, alongside the swap and the
owner's withdrawal, and adding one silently would have invalidated the custody
claim that the rest of the project is built on. It also needs a treasury address,
and inventing a production address is exactly what I should not do.

**The consequence today.** Evaluations and executions are permissionless, so
they are paid by whoever submits them — which is the operator, out of pocket,
with no reimbursement path. Fine for devnet. Not a business.

**What to decide.** Either:

- **No fee.** Nothing to do; `FEES.md` is already correct.
- **A fee on trade output.** Tell me the treasury address and the rate. I will
  pin the address as a compiled-in constant, add a compiled-in ceiling
  independent of any per-vault setting, charge only on successful trades, rewrite
  the custody invariant in `SECURITY_AUDIT.md` and `README.md` to say there are
  three exit paths, and add detectors. Note the existing test
  `has no instruction that can pay anyone but the owner` will start failing —
  deliberately — and must be rewritten rather than deleted.

---

## 3. Devnet SOL runs out — BLOCKS FURTHER DEVNET DEPLOYS

**Phase:** operational.

**The blocker.** A program deploy needs roughly 5.3 SOL of headroom for the
temporary buffer (refunded afterwards). The wallet
`Cbdvwy6Dm7tbCsLP3nw4Umz29BLNQkNwCBDDDRrkbpTZ` sits around 8 SOL, and
`solana airdrop` is rate-limited to the point of being unavailable. I recovered
about 3.6 SOL during the night by sweeping the test wallets I had funded and by
closing the superseded Arcium circuit buffers, which was enough — but there is no
margin for many more deploys.

**What to do.** Top it up from https://faucet.solana.com, or fund it from another
devnet wallet. Nothing is stuck; this only matters when the program next changes.

---

## 4. Two devnet vaults are stranded — INFORMATIONAL, NO ACTION NEEDED

**Phase:** 13 and 19, both understood and documented.

Vaults created before two account-layout changes can no longer be read by the
current program. They hold only the devnet test mint, which is worthless, and
the newer vaults are fine. It is on this list only because you will see them
skipped in the executor logs as `predates the current account layout` and should
know that is expected rather than a fault.

The rule that prevents a repeat is written at `VaultConfig::reserved`, and a test
now asserts the account size does not change. Both layout changes happened
*before* that rule existed; nothing since has broken it.

---

## Not on this list, and worth knowing

- **Nothing has been deployed to mainnet**, and I did not attempt it.
- **No irreversible action was taken** with your keys beyond devnet deploys and
  devnet transfers.
- **No credentials, API keys, or addresses were invented.** The Helius RPC key
  you gave me is the only one in use.
- **The privacy limits are inherent, not pending.** Trades are public and enough
  of them narrow the encrypted thresholds. That is disclosed on the landing page,
  in the app, and in `docs/visibility.md`. It is not a bug to fix in the morning.
