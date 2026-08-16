/**
 * Register a compiled circuit as a computation definition on devnet.
 *
 * Three steps that each succeed on their own and leave something that looks
 * finished: init the definition, upload the bytes, finalize. `uploadCircuit`
 * does the last two, and returns early without error if the definition is not
 * `OnchainPending` — so "no signatures" is a normal-looking way to upload
 * nothing.
 *
 * The byte comparison at the end is not paranoia. A previous upload landed
 * corrupt at byte 814 (exactly one chunk in) and every on-chain field still
 * reported success; `isCompleted` describes the upload, not the contents. The
 * only trustworthy check is reading the bytes back and comparing them.
 *
 *   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=... \
 *     node scripts/register-circuit.mjs <circuit_name> <init_ix_name>
 */
import * as anchor from "@anchor-lang/core";
import web3Pkg from "@solana/web3.js";
import fs from "fs";
import crypto from "crypto";
import {
  getArciumProgram, getCompDefAccAddress, getCompDefAccOffset,
  getRawCircuitAccAddress, getCircuitState, uploadCircuit,
  getMXEAccAddress, getLookupTableAddress,
} from "@arcium-hq/client";

const { PublicKey, SystemProgram } = web3Pkg;

const circuitName = process.argv[2];
const initIx = process.argv[3];
if (!circuitName || !initIx) {
  console.error("usage: register-circuit.mjs <circuit_name> <initIxName>");
  process.exit(1);
}

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Vault;
const arcium = getArciumProgram(provider);
const pid = program.programId;

const artifact = `build/${circuitName}.arcis`;
const local = fs.readFileSync(artifact);
const offset = Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE();
const compDef = getCompDefAccAddress(pid, offset);

console.log(`circuit   ${circuitName} (${local.length} bytes)`);
console.log(`comp def  ${compDef.toBase58()} (offset ${offset})`);

// 1. init
if (!(await provider.connection.getAccountInfo(compDef))) {
  const mxe = getMXEAccAddress(pid);
  const mxeAcc = await arcium.account.mxeAccount.fetch(mxe);
  const sig = await program.methods[initIx]()
    .accountsPartial({
      payer: provider.wallet.publicKey,
      mxeAccount: mxe,
      compDefAccount: compDef,
      addressLookupTable: getLookupTableAddress(pid, mxeAcc.lutOffsetSlot),
      lutProgram: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log(`init      ${sig}`);
} else {
  console.log("init      already exists");
}

// 2 + 3. upload and finalize
const before = await arcium.account.computationDefinitionAccount.fetch(compDef);
console.log(`state     ${getCircuitState(before.circuitSource)}`);
const sigs = await uploadCircuit(provider, circuitName, pid, local, true);
console.log(`upload    ${sigs.length} transactions`);

// 4. read it back and compare, because nothing above proves the bytes are right
await new Promise((r) => setTimeout(r, 6000));
const raw = getRawCircuitAccAddress(compDef, 0);
const info = await provider.connection.getAccountInfo(raw, "confirmed");
const idx = info.data.indexOf(local.subarray(0, 32));
const onchain = info.data.subarray(idx, idx + local.length);
const match = idx >= 0 && Buffer.compare(onchain, local) === 0;

const h = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 32);
console.log(`onchain   ${h(onchain)}`);
console.log(`local     ${h(local)}`);

const after = await arcium.account.computationDefinitionAccount.fetch(compDef);
console.log(`state     ${getCircuitState(after.circuitSource)}`);

if (!match) {
  for (let i = 0; i < local.length; i++) {
    if (onchain[i] !== local[i]) {
      console.error(`MISMATCH at byte ${i} (chunk ${Math.floor(i / 814)})`);
      break;
    }
  }
  process.exit(1);
}
console.log("BYTES MATCH");
