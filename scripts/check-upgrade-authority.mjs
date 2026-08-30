/**
 * Refuse to ship if the upgrade authority is a hot key.
 *
 * T-3 is the most serious finding in SECURITY.md and the only one this
 * repo cannot fix from inside the program: whoever holds the upgrade authority
 * can replace `withdraw` with a version that pays an operator, which makes
 * every other control conditional on that key. It was recorded as a
 * pre-mainnet checklist item, and a checklist is not a control — it is a note
 * about a control someone might remember to apply.
 *
 * This is the control. It reads the authority off chain and compares it to an
 * expected multisig, exiting non-zero on any mismatch so a deploy pipeline
 * stops rather than proceeds.
 *
 *   node scripts/check-upgrade-authority.mjs \
 *     --program <id> --rpc <url> --expect <multisig pubkey>
 *
 * With no `--expect`, it reports what it finds and fails if the authority is a
 * plain system-owned keypair — the state devnet is in today.
 */
import web3 from "@solana/web3.js";

const { Connection, PublicKey } = web3;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const programId = arg("program", "J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ");
const rpc = arg("rpc", process.env.EXECUTOR_RPC ?? "https://api.devnet.solana.com");
const expected = arg("expect", process.env.EXPECTED_UPGRADE_AUTHORITY);

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const conn = new Connection(rpc, "confirmed");
const program = new PublicKey(programId);

const programAcc = await conn.getAccountInfo(program);
if (!programAcc) {
  console.error(`FAIL: program ${programId} not found on ${rpc}`);
  process.exit(1);
}
if (!programAcc.owner.equals(BPF_LOADER_UPGRADEABLE)) {
  console.log(`OK: program is not upgradeable (owner ${programAcc.owner.toBase58()})`);
  process.exit(0);
}

// ProgramData address lives at bytes 4..36 of the program account.
const programData = new PublicKey(programAcc.data.subarray(4, 36));
const dataAcc = await conn.getAccountInfo(programData);
if (!dataAcc) {
  console.error("FAIL: program data account missing");
  process.exit(1);
}

// ProgramData layout: 4-byte tag, 8-byte slot, 1-byte Option, 32-byte authority.
const hasAuthority = dataAcc.data[12] === 1;
if (!hasAuthority) {
  console.log("OK: upgrade authority is None — the program is immutable.");
  process.exit(0);
}
const authority = new PublicKey(dataAcc.data.subarray(13, 45));

console.log(`program:   ${programId}`);
console.log(`authority: ${authority.toBase58()}`);

if (expected) {
  if (authority.toBase58() === expected) {
    console.log(`OK: authority matches the expected multisig.`);
    process.exit(0);
  }
  console.error(`FAIL: expected ${expected}`);
  console.error("Refusing to ship: the upgrade authority is not the multisig.");
  process.exit(1);
}

// No expectation given: still refuse the specific state that makes T-3 live.
const authorityAcc = await conn.getAccountInfo(authority);
const owner = authorityAcc?.owner?.toBase58() ?? SYSTEM_PROGRAM;
if (owner === SYSTEM_PROGRAM) {
  console.error(
    "FAIL: the upgrade authority is a plain keypair (system-owned), not a\n" +
      "      multisig. Whoever holds it can replace withdraw. See T-3.\n" +
      "      Pass --expect <multisig> once the authority has been moved."
  );
  process.exit(1);
}
console.log(`OK: authority is program-owned (${owner}) — looks like a multisig.`);
