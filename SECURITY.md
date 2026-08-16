# SECURITY.md

Security assumptions, honest claims, and disclosure policy.

> **Status: implemented, self-audited, not externally audited.** "No code has
> been written" was true when this line was added and false for a long time
> after; it is corrected here because a stale disclaimer is its own hazard —
> it invites discounting the controls that do hold.
>
> The program is deployed on devnet and exercised by 92 tests. What each
> control is actually worth — enforced, coded-but-untested, or claimed and
> absent — is graded threat by threat in
> [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md). No third party has reviewed any of
> it, and the upgrade authority is still a single hot key (T-3).

---

## 1. What we claim

- The platform operator holds **no key that can withdraw, redirect, or arbitrarily trade user
  funds.** No instruction accepts an operator authority.
- Trade authorization requires a **BLS threshold signature** from the pinned Arcium cluster,
  verified on-chain. The operator cannot forge one.
- Strategy parameters are evaluated under MPC and stay confidential against the operator in
  normal operation, and against **any n−1 colluding cluster nodes**.
- A fully compromised backend cannot move funds, read plaintext strategies, or fabricate
  trades. Its worst case is refusing to schedule work.
- **Withdrawal never depends on us, on Arcium, or on any third party.** See §4.

## 2. What we explicitly do not claim

| Tempting claim | Reality |
|---|---|
| "Unruggable" | The operator cannot withdraw funds, but can upgrade the program until the upgrade authority is a timelocked multisig. |
| "Your strategy is invisible" | Every executed trade is public. Thresholds are statistically inferable — see §3.2. |
| "Private from the operator, unconditionally" | We hold the Arcium MXE authority. See §3.1. |
| "Impossible to front-run" | Trade intent is briefly public before execution. |
| "Guaranteed stop-loss" | MPC takes seconds. In fast markets the trade fails rather than fills badly. |

## 3. The two disclosures that matter most

### 3.1 We hold the Arcium MXE authority

The MXE authority can migrate the MXE to a different Arcium cluster through key recovery.
Fully operator-controlled clusters ("invite only Arx nodes controlled by the organization")
are a documented, supported Arcium feature.

**There is currently no way to burn, transfer, or timelock this authority.** The Arcium CLI
exposes no `set-authority` command, and MXE initialization requires a local keypair file,
which a multisig cannot provide.

What we have done about it: the vault program **pins the cluster account to a compiled-in
constant**. This means an operator who migrated could **not** forge trade authorizations —
attestations from any other cluster are rejected — and every bot would visibly halt on-chain.

**What remains:** an operator who migrated could decrypt strategy ciphertext **already
published on-chain**. This is inherent — anything the MXE can compute on, the MXE key can
decrypt, and on-chain data is permanent.

**Therefore: treat operator-level strategy confidentiality as trust-based, not
cryptographically enforced.** We disclose this rather than claim protection we do not have.

### 3.2 Your thresholds leak through your trades

An observer who records the oracle price at each evaluation and sees which ones produced a
trade can bound your trigger prices from both sides. Enough observations narrow them
arbitrarily.

This is inherent to acting on a public blockchain. Jittered evaluation timing, randomised
trade sizing, and threshold bands slow it down. **Nothing prevents it.**

## 4. Emergency withdrawal

`withdraw` touches **no Arcium account and no MagicBlock account**. It requires only the
vault config, the vault's token accounts, the owner's token account, the owner's signature,
and the SPL Token program.

Withdrawal therefore continues to work if:

- the Arcium cluster halts, or every Arx node goes offline
- the MXE is closed, migrated, or cluster pinning rejects every evaluation
- our backend, scheduler, and executor all disappear
- Jupiter is unavailable
- the vault is paused — `pause` blocks new trades, never withdrawals

The only requirements are that Solana is live and you can sign.

## 5. Security assumptions

1. **At least one honest Arx node** in the pinned cluster (Cerberus dishonest-majority).
2. **No liveness guarantee.** Cerberus is detect-and-abort: any single node can abort any
   computation. The system fails closed — no result means no trade, never a default action.
3. **BLS soundness**, plus the pinned cluster constant being correct.
4. **The MXE authority is trusted** for confidentiality of already-stored strategies (§3.1).
5. **Recovery Peers** (≥4) hold encrypted shares of the MXE key and cannot refuse a migration.
6. **The program upgrade authority is trusted** until timelocked.
7. **Frontend integrity** — the builder page sees plaintext by necessity. Users who do not
   trust the served frontend should self-host.
8. **Threshold inference is unfixable** (§3.2).

Assumptions 4 and 8 are where this product could most easily overclaim. They are stated
plainly in the README and must stay in any user-facing copy.

## 6. Mainnet gates

Not exhaustive; blocking items only.

- [ ] External audit of the vault program
- [ ] Program upgrade authority moved to a timelocked multisig
- [ ] Cluster pinning verified by test on devnet, including the negative case
- [ ] Emergency withdrawal verified under simulated Arcium unavailability
- [ ] Full latency benchmark published (p50/p95/worst, failure rate)
- [ ] Q-A resolved with Arcium: can the MXE authority be a multisig? Can migration be timelocked?
- [ ] Claims in README and UI reviewed against this document

## 7. Reporting a vulnerability

Not yet accepting reports — there is no deployed code. A disclosure contact and policy will be
added before devnet deployment carries any user funds.

Do not open public issues for security findings once code exists.
