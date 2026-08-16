# RESEARCH.md

Research conducted 2026-08-15 against current official documentation. Every claim
below is sourced. Where documentation is silent, this document says so explicitly
rather than guessing.

**Primary sources**
- Arcium docs, full corpus: `https://docs.arcium.com/llms-full.txt` (349 KB, retrieved 2026-08-15)
- MagicBlock docs, full corpus: `https://docs.magicblock.gg/llms-full.txt` (516 KB, retrieved 2026-08-15)
- Jupiter developer docs index: `https://dev.jup.ag/docs/llms.txt`
- Pyth: `https://docs.pyth.network/price-feeds/core/best-practices`
- Surfpool: `https://docs.surfpool.run/`, `https://github.com/solana-foundation/surfpool`

---

## 1. Headline findings

Three findings materially change the architecture proposed in the brief.

| # | Finding | Consequence |
|---|---------|-------------|
| **F1** | `MXESigningKey` produces **`ArcisEd25519`** signatures, which use **SHA3-512 internally**, not SHA-512. These are *not* RFC-8032 Ed25519 signatures. | An MXE signing key **cannot be a Solana transaction signer** and cannot be verified by Solana's ed25519 precompile. The "MXE key controls the vault" design is **not implementable**. |
| **F2** | The Arcium callback is already authenticated on-chain by a **BLS threshold signature** over the computation output, verified inside *our* program via `verify_output()`. | We do not need `MXESigningKey` at all. The BLS-attested callback *is* the trust-minimised authorization channel, and it is **stronger** than a signature blob because our program enforces the rules. |
| **F3** | In a MagicBlock Ephemeral Rollup, **only delegated accounts are writable**. A Jupiter swap mutates DEX pool accounts that are not, and cannot be, delegated. | **A Jupiter swap cannot execute inside an Ephemeral Rollup.** MagicBlock cannot accelerate the trade leg. Recommendation: exclude from V1 and V2. |

---

## 2. Arcium

### 2.1 Network availability

> "The Arcium Network is live on Solana mainnet."
> — `docs.arcium.com/developers`

Cluster offsets (`arcium deploy --cluster-offset`):

| Network | Offset |
|---------|--------|
| Devnet | `456` |
| Mainnet | `2026` |

Deployment requires `--recovery-set-size` (minimum `4`). The CLI defaults to
**mainnet** if `--rpc-url` is omitted — a documented footgun worth guarding in
our scripts.

### 2.2 MPC protocol and security model — VERIFIED

Clusters run **Cerberus**, described as:

> "a dishonest-majority, detect-and-abort MPC protocol. Cerberus uses secret sharing
> and authenticated values. Under the assumption that at least one Cluster member is
> honest, it preserves privacy and aborts when it detects a protocol fault rather than
> returning a corrupted result."

And:

> "Arcium uses a **dishonest majority** model: privacy is maintained as long as at
> least one node remains honest, even if every other node colludes."

This is the exact security assumption. Two consequences that must be stated
honestly in any product claim:

- **Confidentiality is strong**: 1-of-n honest. Even n−1 colluding nodes learn nothing.
- **Liveness is weak**: "detect-and-abort" means *any single faulty or malicious node
  can abort the computation*. There is no robustness guarantee. A trading system built
  on this must treat "no decision produced" as a normal, frequent state — never as an
  error condition that fails open.

Arcium's own recommended mitigation for maximum assurance:

> "For maximum assurance, you can run your own node in a cluster. Since you trust
> yourself, this guarantees at least one honest participant."

### 2.3 `MXESigningKey` — VERIFIED, AND UNSUITABLE FOR CUSTODY

This was the single most important item to verify. It exists, but not in the form the
brief assumes.

**It exists.** It is an Arcis circuit primitive:

```rust
#[instruction]
pub fn cluster_sign(message: [u8; 32]) -> ArcisEd25519Signature {
    MXESigningKey::sign(&message).reveal()
}
```

Documented as "Sign messages using the MXE cluster's collective key." The private key
exists only as secret shares across Arx nodes — consistent with the desired
"no single party holds the key" property.

**But it cannot control a Solana account.** The blocking fact:

> "Arcis provides Ed25519 signature operations using **SHA3-512** internally (ArcisEd25519)."

and the stated reason:

> "Arcis uses SHA3 (Keccak) rather than SHA-2/SHA-512 because SHA3 has a more efficient
> circuit structure for MPC evaluation."

RFC-8032 Ed25519 — the scheme Solana uses for transaction signatures and in its
`ed25519` precompile — is defined over **SHA-512**. Substituting SHA3-512 yields a
different, incompatible signature scheme. Therefore:

- An `ArcisEd25519Signature` is **not** a valid Solana signature. The MXE key cannot be
  a transaction signer, a fee payer, or an `Authority` on a token account.
- Solana's ed25519 precompile will **not** verify it. Verification would require
  implementing SHA3-512 Ed25519 verification manually inside our program — expensive,
  and pointless given F2.

**Additional gaps** (documentation is silent, so we must assume the worst):

- ~~There is no documented API to retrieve the MXE signing public key.~~ **Correction:**
  `arcium mxe-info <program-id>` prints it as `ArcisEd25519 pubkey` (observed:
  `6ERSm4bpepSMoT7E4hwq8cKdU9miJQqArfpt35PwMnum` for our vault MXE), so it is
  retrievable after all. This does **not** change the verdict: the key is still
  SHA3-512 Ed25519, so it cannot sign a Solana transaction and Solana's
  precompile cannot verify its signatures. The blocker is the scheme, not
  key discovery.
- There is **no documented authorization model** for signing. Nothing gates *what* may be
  signed beyond what the circuit author writes. Anyone who can queue a computation against
  a `cluster_sign`-style instruction can obtain a signature over a message of their choosing.
- Signature stability across **cluster migration** (§2.6) is not documented.

**Verdict: `MXESigningKey` is not suitable as the custody/execution authority for a
Solana vault.** This triggers stop condition #2 in the brief. The proposed replacement
(§2.4) is not the weaker "Squads fallback" from the brief — it is a *stronger* design.

### 2.4 Callback authentication — the actual authorization channel

Computation results are returned to our program through a callback whose payload is
`SignedComputationOutputs<T>`, verified by:

```rust
let o = match output.verify_output(
    &ctx.accounts.cluster_account,
    &ctx.accounts.computation_account
) {
    Ok(data) => data,
    Err(_) => return Err(ErrorCode::AbortedComputation.into()),
};
```

> "`verify_output()` performs real BLS signature verification against the cluster's BLS key"

The BLS keys are per-node and aggregated cluster-wide:

> "This keypair is used for BLS (Boneh-Lynn-Shacham) threshold signatures on MPC
> computation callbacks."

> "Once all nodes have joined the cluster, **all nodes** must aggregate and submit the
> combined BLS public key. This enables threshold BLS signatures for computation callbacks."

**This is the threshold-signing primitive the product actually needs.** It is verified
on-chain, inside our program, and binds the result to a specific `computation_account`.
No operator, and no single node, can forge it.

Note a separate role: each Arx node also holds a plain Solana **callback authority
keypair** that pays for and signs the callback *transaction*:

> "This Solana keypair signs callback computations and must be different from your node
> keypair for security separation."

Distinguish these carefully. The callback transaction signer is an ordinary Solana
keypair held by one node — it provides **no** security guarantee. The security comes
from the BLS aggregate signature *inside* the payload. Our program must trust
`verify_output()` and never the transaction signer.

### 2.5 Encrypted state — `Enc<Mxe, T>` vs `Enc<Shared, T>` — VERIFIED

| Type | Who can decrypt |
|------|-----------------|
| plaintext | "All Arx nodes" |
| `Enc<Shared, T>` | "Client + MXE" |
| `Enc<Mxe, T>` | "MXE only" |

Persistent confidential state is supported and is the documented pattern — the order-book
example passes `Enc<Mxe, OrderBook>` in and writes it back with `owner.from_arcis(ob)`.
The docs explicitly warn:

> "If `ob_ctxt` were `Enc<Shared, OrderBook>`, any user could decrypt the entire order book."

Output conversion:
- `.reveal()` → plaintext, "becomes visible to everyone".
- `.from_arcis()` → ciphertext; "The ciphertext is public bytes; the plaintext remains protected."

For our strategy state this maps cleanly: the strategy struct lives as `Enc<Mxe, Strategy>`,
and only the *action* is `.reveal()`ed.

### 2.6 MXE authority and cluster migration — SIGNIFICANT THREAT, NOT IN THE BRIEF

> "An MXE authority can move an MXE from one active Cluster to another through key recovery."
> "The MXE's Recovery Peers participate in key recovery so the destination Cluster can
> continue using the MXE's key material."

Via `arcium migrate-cluster <mxe-program-id> --cluster-offset <new>`.

The `--recovery-set-size` parameter (min 4) sets "how many nodes form the recovery set
that holds encrypted key shares of your MXE's key."

**This is a privilege-escalation path against strategy confidentiality that the brief did
not anticipate.** The MXE authority — i.e. *us, the platform operator* — can migrate the
MXE to a destination cluster. If an operator could migrate to a cluster whose nodes they
wholly control, the "at least one honest node" assumption collapses and previously-encrypted
`Enc<Mxe, Strategy>` state becomes recoverable by that operator.

**Follow-up investigation (2026-08-15) — the threat is worse than first assessed, and the fix
is different from the one first proposed.**

**(a) A fully operator-controlled cluster is an explicitly supported product feature.**
From `clusters/permissioned-clusters`:

> "**Internal:** Invite only Arx nodes controlled by the organization."
> "An organization can invite only self-operated Arx nodes, giving it operational control over
> the hosts."

So the migration target need not be found — it can be built, using documented features. Cluster
membership is authority-gated and invitation-based throughout.

**(b) There is no way to transfer, burn, or timelock the MXE authority.** The complete
Arcium CLI surface is: `activate-cluster`, `arx-active`, `arx-info`, `build`,
`close-computation-definition`, `close-computation-definition-buffers`, `close-mxe`,
`completions`, `deactivate-computation-definition`, `deploy`, `gen-bls-key`, `generate-x`,
`init`, `init-arx-accs`, `init-cluster`, `join-cluster`, `localnet`, `migrate-cluster`,
`program`, `propose-join-cluster`, `snapshot-mxe-keygen`, `submit-aggregated-bls-key`, `test`.

**No `set-authority`, `transfer-authority`, or equivalent exists.** Additionally, fresh MXE
init requires the *program's upgrade authority* to sign, and `arcium deploy` takes a
`--keypair-path` — a local keypair file, which a multisig PDA cannot provide.

**(c) Recovery Peers are not a consent gate.** They are staked, role-bound (stake "cannot also
back an Arx node", enforced on-chain), separate from cluster nodes, and earn 20% of the
computation reward basis. But the docs describe them mechanically — they "participate when an
MXE authority initiates key recovery or migration" and "help transfer the MXE's key material".
**No veto or refusal mechanism is documented.** We cannot rely on them to block a migration.

**(d) The critical escalation: migration is not only a confidentiality problem — without a
countermeasure it is a *custody* problem.** The generated Anchor account constraint is:

```rust
#[account(address = derive_cluster_pda!(mxe_account))]
pub cluster_account: Box<Account<'info, Cluster>>,
```

The cluster account is **derived from the MXE account**, so it silently follows the MXE's
current binding. And `verify_output()` checks the BLS signature **against whatever cluster
account is passed**. Therefore an operator who migrates the MXE to a cluster they control would
be able to **produce BLS attestations that our program accepts as genuine MPC results** — i.e.
forge trade authorizations. That is a far more serious finding than strategy disclosure.

**(e) The countermeasure: pin the cluster account to a constant.** Our program must not accept
the derived address. It must assert `cluster_account.key() == EXPECTED_CLUSTER_PDA`, a hardcoded
constant per network. This closes (d) completely and converts migration into a loud, halting,
publicly detectable event. See ARCHITECTURE.md §7.1.

**What remains unfixable:** an operator who migrates recovers MXE key material and can then
decrypt **historical on-chain strategy ciphertexts**. This is inherent — anything the MXE can
compute on, the MXE key can decrypt, and on-chain ciphertext is permanent. Cluster pinning stops
the bot and stops forgery; it cannot retroactively protect ciphertext already published.

See THREAT_MODEL.md T-7 and T-37.

### 2.7 Hard constraints on circuits (Arcis)

| Pattern | Status |
|---------|--------|
| `Vec`, `String`, `HashMap` | Not supported — fixed-size arrays/structs |
| `while`, `loop` | Not supported — `for` with fixed bounds |
| `break`, `continue`, early `return` | Not supported |
| `.reveal()` / `.from_arcis()` inside non-constant conditionals | Not supported |
| Enums / `Option<T>` as circuit input or output | Not supported |

Cost model: **both branches of an `if/else` always execute** unless the condition is a
compile-time constant. Cost is the *sum* of branches, not the max. Comparisons are
expensive; addition/multiplication are near-free.

This is why user-supplied arbitrary code is not feasible in the near term (Phase 16): every
strategy must compile to a **fixed-shape circuit**. A DSL that compiles to a fixed opcode
array with a bounded interpreter loop is the only viable path.

### 2.8 The 1,232-byte callback ceiling — ARCHITECTURALLY DECISIVE

> "Solana limits a serialized transaction to 1,232 bytes. Callback output shares this limit
> with signatures, account keys, instructions, and other callback data... If Arx cannot build
> the callback as a single transaction, the computation fails with `OutputTooLarge`."

A Jupiter swap CPI requires many accounts and sizeable route data. **Performing the swap
inside the Arcium callback is not feasible.** The callback must do one small thing: write a
compact, authorized *trade intent* to a vault-owned account. A separate transaction then
executes the swap against that intent.

This split is not a workaround — it is also better security design, because it lets the
swap transaction be permissionless and fully constrained by on-chain state.

### 2.9 Latency and cost

The documentation **does not publish MPC latency figures.** What is documented:

- Queued computations expire after **180 slots (~72 s)**; the fee is then reclaimable.
- The TS client's `awaitComputationFinalization` default timeout is **120,000 ms**.
- Cerberus uses offline preprocessing to shift work out of the latency-critical path, but
  "Arx nodes still need sufficient preprocessing material and availability."
- Pricing = cluster base price per Computation Unit × the comp def's CU count, + optional
  priority fee, + a fixed reserve for the callback transaction. CU price is set by node
  operator vote each epoch.

**Conclusion: end-to-end latency is unknown and must be benchmarked before any latency
claim is made.** The 72 s queue TTL and 120 s default client timeout strongly suggest an
operating regime of seconds to tens of seconds, not milliseconds. This is a
*rule-evaluation* system, not a low-latency trading system, and the product must be
positioned accordingly.

---

## 3. MagicBlock

> **Superseded by a deeper evaluation.** This section established only that a *Jupiter swap*
> cannot run in an ER. The follow-up question — whether an ER can accelerate the accounts *we*
> control — is answered in full in [`docs/magicblock-evaluation.md`](docs/magicblock-evaluation.md).
> Short version: delegated accounts are **locked on L1**, and both the Arcium BLS callback and
> the swap are L1 writes to exactly the accounts we would want to delegate. There is no
> critical-path integration point.

### 3.1 The decisive constraint

From the MagicBlock FAQ:

> **"Can delegated accounts compose with all programs on Solana?"**
> "Yes. Delegated accounts can benefit from all Solana programs and accounts. **Every account
> on Solana is readable on ER, while only delegated account can be changed on ER** within an
> atomic transaction."

Also:
> "Program accounts are never delegated. Only state accounts can be delegated."
> "Delegated account must exist on Solana beforehand."

A Jupiter swap **writes** to DEX pool state — Raydium/Orca vaults, tick arrays, oracle
accounts — owned by third-party programs. Those accounts are not ours and cannot be
delegated to our ER session. **Therefore a Jupiter swap cannot execute in an Ephemeral
Rollup.**

MagicBlock's own product confirms this: their Ephemeral SPL Token "swap" endpoint documents
`visibility: "public"` as *"pure pass-through to the Jupiter/Metis upstream"* — the swap
happens on L1. The ER portion only schedules a private transfer afterwards.

### 3.2 Delegated accounts are locked on L1

The mechanic that decides the whole evaluation:

> "`Delegation` is the process of **transferring ownership** of one or more of your program's
> `PDAs` to the delegation program."
> "After the finalization process, the PDAs **remain locked on base layer**."

While delegated, an account cannot be written on L1. Our two mandatory L1 writes — the Arcium
BLS callback writing `TradeIntent`, and `execute_trade` writing `consumed`/nonce/cooldown —
target exactly the accounts we would want to delegate. **Delegating them would break the
Arcium authorization path and the swap.**

ER runtime reference points: slot ~10 ms (vs ~400 ms L1), transaction size 64 KB (vs 1,232
bytes), same CU limits.

### 3.3 Recommendation

**Do not integrate MagicBlock in V1 or V2.** Full analysis of all seven candidate integration
points, the eATA/Magic Actions steelman, and the benchmark design is in
[`docs/magicblock-evaluation.md`](docs/magicblock-evaluation.md). Summary:

1. **Structural** — no critical-path account can be delegated (§3.2).
2. **Custody** — every fund-touching variant makes withdrawal depend on ER validator liveness.
   Undelegation is initiated on the ER and finalised "through validator CPI"; no user-initiated
   force-undelegation escape hatch is documented.
3. **Latency** — the bottleneck is Arcium MPC, which MagicBlock cannot touch.
4. **Fit** — MagicBlock's own trading architecture assumes an internal venue; ours is external.

Revisit only if the product adds an internal matching engine, or if Arcium benchmarks come back
sub-second.

---

## 4. Jupiter

Current API: **Swap API V2** at `api.jup.ag/swap/v2`, two integration paths:

| Path | Endpoints | Properties |
|------|-----------|-----------|
| **Meta-Aggregator** | `GET /order` + `POST /execute` | All routing engines compete (Metis, JupiterZ RFQ, DFlow, OKX). Managed landing, MEV protection, gasless. Transaction is **not** modifiable. |
| **Router** | `GET /build` + `POST /submit` | Raw instructions, full transaction control, **CPI composability**, no swap fees, Metis on-chain routing only. |

**We must use the Router `/build` path**, because our funds sit in a PDA-owned token
account and the swap must be performed by our program via `invoke_signed`. The
Meta-Aggregator path returns a pre-assembled transaction we cannot compose into.

### 4.1 The CPI account-count constraint

> "CPI cannot use Address Lookup Tables (ALTs), which limits the number of accounts in the
> transaction. Jupiter's complex routing often requires many accounts. Use `maxAccounts` on
> `/build` to control route complexity and keep the transaction within size limits."

Because a PDA can only sign via `invoke_signed` (i.e. via CPI), and CPI forfeits ALTs, we
must cap route complexity with `maxAccounts`. For USDC↔SOL this is not a real cost —
liquidity is deep and direct routes are competitive.

This constraint is *aligned* with our security posture: constraining routes is something we
would want to do anyway. Simple, verifiable routes are easier to validate on-chain than
arbitrary multi-hop ones.

**Flash-Fill** (top-level swap instruction, ALTs allowed, program lends/reclaims around it)
is the documented alternative, but it assumes the swapping authority is a *wallet* signer.
It does not straightforwardly apply to PDA-held funds. To verify during Phase 12, not now.

### 4.2 MEV

Jupiter offers MEV protection on the `/execute` path and via `tx.jup.ag` submission with a
SOL tip. Since we are on the `/build` path, we do not get `/execute`'s protection
automatically; we can still submit through `tx.jup.ag` with a tip. Regardless, our primary
defences must be on-chain: enforced `minimum_out`, an oracle sanity band, and intent expiry.

### 4.3 Measured, not assumed (Phase 12)

§4.1 argued from the docs that `maxAccounts` would make CPI viable. Measured against
the live `GET https://api.jup.ag/swap/v2/build`, USDC→SOL, 500 USDC:

| request | swap ix accounts | hops | out (lamports) |
|---------|-----------------|------|----------------|
| default | 43 | 3 | 6,647,762,591 |
| `maxAccounts=30` | 42 | 2 | 6,647,648,655 |
| `maxAccounts=24` | 38 | 2 | 6,647,680,641 |
| `maxAccounts=16&onlyDirectRoutes` | **21–22** | 1 | 6,647,760,174 |

Two things this changes:

**`maxAccounts` alone does not do it.** At `maxAccounts=32` the instruction still carried
43 accounts. It biases routing, it does not bound the account list. `onlyDirectRoutes=true`
is what actually bounds it.

**The cost of constraining is ~0.04 bps.** 2,417 lamports on 6.65 SOL, versus the
unconstrained 3-hop route. §4.1 predicted this would be cheap for USDC↔SOL; it is.

Size, compiled as a legacy message (CPI forfeits the route's 3 ALTs / 750 addresses):

```
jupiter swap ix accounts : 21
unique accounts in tx    : 22      (vault ATAs already appear as swap source/destination)
serialized message bytes : 819
plus 1 signature         : 884
limit                    : 1232  -> 348 bytes headroom
```

So the CPI fits with room for compute-budget instructions. The pessimistic reading — that
43 account keys alone (1,376 bytes) blow the 1,232-byte limit — is true and is exactly why
`onlyDirectRoutes` is not optional.

**Swap program ID, confirmed live in the `/build` response:**
`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`. The docs pages do not publish it; this is
read from the returned `swapInstruction.programId`. Pin it (T-2) — never take a program ID
from instruction data.

### 4.4 Devnet has no Jupiter liquidity

The program is deployed on devnet at the same address, but routes do not exist for
realistic pairs. Phase 12 therefore cannot be verified the way Phase 11 was.

This also breaks the Phase 11 rig in the other direction: our devnet vault uses a test
quote mint that does not exist on mainnet, and the Arcium MXE lives on devnet cluster 456,
which a mainnet fork does not have. So no single environment runs the whole path:

| environment | has Jupiter liquidity | has Arcium MXE | covers |
|-------------|----------------------|----------------|--------|
| devnet | no | yes | strategy → verified callback → `TradeIntent` |
| surfpool mainnet fork | yes (forked state) | no | `TradeIntent` → swap → post-conditions |

The seam is `TradeIntent`. On the fork it must be seeded directly rather than produced by a
callback — `verify_output` cannot be mocked (§6), and adding a test-only instruction that
writes an intent would put a forged-authorization path in the shipped program. Seed the
account with a surfpool cheatcode instead, so nothing test-only enters the program.

---

## 5. Pyth

Pull-based oracle: price updates are posted on demand rather than pushed continuously.

Documented best practices we will enforce:

- **Staleness.** Use `get_price_no_older_than()` with an explicit threshold. "Integrators
  should be careful to avoid accidentally using a stale price."
- **Confidence intervals.** "By using the lower bound of the confidence interval, derivative
  protocols can protect themselves from price manipulation that drives the price down"
  (and the upper bound for the opposite direction).
- **Wide confidence = degraded data.** "When the ratio of confidence to price exceeds a
  threshold, widen spreads or cap the maximum trade size." We will instead **refuse to
  trade** when `conf/price` exceeds a configured ceiling — simpler and safer.
- **Do not race adversaries.** "Adversaries are highly likely to win these races, as they
  have a head start." This is a direct warning against designs where a price update must
  beat an attacker's transaction. Our design must not depend on winning such a race.

### 5.1 Oracle vs execution quote — recommendation

Use **both, for different jobs**, and never interchange them:

| Job | Source | Why |
|-----|--------|-----|
| **Strategy trigger** (is price below the secret threshold?) | **Pyth** | Signed, attestable, has a confidence interval, and is not manipulable by trade flow in a single block. A DEX-derived spot price is trivially manipulable by an attacker who wants to trigger someone's stop. |
| **Execution quote / sizing** | **Jupiter `/build`** | It is the actual executable price including route and impact. An oracle price is not executable. |
| **Sanity band at settlement** | **Pyth, checked on-chain** | Reject the swap if the realised execution price deviates from the Pyth band beyond tolerance. |

Using a DEX price as the strategy trigger would be a serious vulnerability: an attacker
could push the pool price to fire a victim's stop-loss and take the other side. Pyth as
trigger + Jupiter as quote + Pyth as on-chain guard is the correct separation.

---

## 6. Surfpool

A drop-in replacement for `solana-test-validator` that **forks mainnet state on demand** —
it "fetches live account data on demand from any RPC of your choice, while isolating and
tracking your program's state locally."

This is exactly what we need to test the parts that depend on real mainnet accounts:
Jupiter's program and pool accounts, Pyth price feed accounts, SPL mints. Those are
impossible to reproduce faithfully on a bare local validator and painful on devnet
(devnet Jupiter liquidity is not representative).

**Open question (Q6):** Arcium ships its own local cluster via `arcium test`
(`Arcium.toml` → localnet). Whether `arcium test` can be pointed at a Surfpool-forked
validator is **not documented**. If it cannot, our test strategy must be layered:

| Layer | Environment | Covers |
|-------|-------------|--------|
| Circuit logic | `arcis` unit tests | Pure strategy evaluation |
| Vault + Jupiter + Pyth | **Surfpool** (mainnet fork), Arcium callback **mocked** | Custody, limits, swap execution, oracle guards |
| Arcium integration | `arcium test` localnet, Jupiter **stubbed** | Encryption, queue, callback, BLS verification |
| Full end-to-end | **Devnet** | Everything, slowly |

Note `verify_output()` cannot be unit-tested — "a mocked `SignedComputationOutputs` with a
dummy signature always fails verification." The BLS path is only exercisable via
`arcium test` or devnet.

---

## 7. What is not currently possible

| Requirement from the brief | Status | Detail |
|---|---|---|
| MXE signing key controls the vault | **Not possible** | F1 — SHA3-512 Ed25519 is not Solana-compatible |
| Threshold-signed *Solana transactions* from Arcium | **Not possible** | Same root cause |
| Threshold-attested *authorization* from Arcium | **Possible today** | BLS `verify_output()`, verified on-chain |
| Persistent encrypted strategy state | **Possible today** | `Enc<Mxe, Strategy>` |
| Swap inside the Arcium callback | **Not possible** | 1,232-byte callback ceiling |
| Swap inside a MagicBlock ER | **Not possible** | Non-delegated pool accounts are read-only |
| Hiding *that* a trade happened | **Not possible** | Public DEX, public chain |
| Hiding trade side/size/time | **Not possible** | Required by the executing swap |
| Hiding strategy thresholds | **Possible, with caveats** | Statistically inferable from repeated trades — see THREAT_MODEL T-9 |
| Arbitrary user code execution | **Not currently viable** | Fixed-shape circuits; needs a bounded DSL |
| Strategy confidentiality *against the operator* | **Conditional** | Only if MXE authority is removed from operator control — §2.6 |

---

## 8. Sources

- [Arcium — Developers](https://docs.arcium.com/developers)
- [Arcium — Arcis Primitives](https://docs.arcium.com/developers/arcis/primitives)
- [Arcium — Input/Output](https://docs.arcium.com/developers/arcis/input-output)
- [Arcium — Current limitations](https://docs.arcium.com/developers/limitations)
- [Arcium — Callback type generation](https://docs.arcium.com/developers/program/callback-type-generation)
- [Arcium — Deployment](https://docs.arcium.com/developers/deployment)
- [Arcium — Node setup](https://docs.arcium.com/developers/node-setup)
- [Arcium — Cluster migration](https://docs.arcium.com/clusters/cluster-migration)
- [Arcium — MPC protocols (Cerberus)](https://docs.arcium.com/multi-party-execution-environments-mxes/mpc-protocols)
- [MagicBlock — Ephemeral Rollups FAQ](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/faq)
- [MagicBlock — Delegation, Commitment & Undelegation](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup.md)
- [Jupiter — Swap API overview](https://developers.jup.ag/docs/swap/index.md)
- [Jupiter — Build (Router path)](https://developers.jup.ag/docs/swap/build/index.md)
- [Jupiter — Common instructions](https://developers.jup.ag/docs/swap/build/common-instructions)
- [Pyth — Best practices](https://docs.pyth.network/price-feeds/core/best-practices)
- [Surfpool docs](https://docs.surfpool.run/)
- [Surfpool on GitHub](https://github.com/solana-foundation/surfpool)
