import * as anchor from "@anchor-lang/core";
import web3Pkg from "@solana/web3.js";
import fs from "fs";
import crypto from "crypto";
import { getArciumProgram, getCompDefAccAddress, getCompDefAccOffset, getRawCircuitAccAddress } from "@arcium-hq/client";
const { PublicKey, Keypair, SystemProgram } = web3Pkg;

const CHUNK = 814;
const BATCH = 8;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const arcium = getArciumProgram(provider);

const pid = new PublicKey("HVEKKMWwjLaQyXqkMGGshNGXa3Wm1PCSUnRaB6vAnB99");
const compOffset = Buffer.from(getCompDefAccOffset("add_ten")).readUInt32LE();
const cd = getCompDefAccAddress(pid, compOffset);
const raw = getRawCircuitAccAddress(cd, 0);
const owner = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, "utf-8"))));

const local = fs.readFileSync("build/add_ten.arcis");
const nChunks = Math.ceil(local.length / CHUNK);
console.log(`rewriting ${nChunks} chunks of ${CHUNK} bytes (${local.length} total)`);

const send = async (i) => {
  const off = i * CHUNK;
  const slice = Buffer.alloc(CHUNK);
  local.copy(slice, 0, off, Math.min(off + CHUNK, local.length));
  for (let a = 0; a < 6; a++) {
    try {
      await arcium.methods
        .uploadCircuit(compOffset, pid, 0, Array.from(slice), off)
        .accountsPartial({ signer: owner.publicKey, compDefAcc: cd, compDefRaw: raw, systemProgram: SystemProgram.programId })
        .signers([owner])
        .rpc({ skipPreflight: true, commitment: "processed", preflightCommitment: "processed" });
      return true;
    } catch (e) {
      if (a === 5) { console.log(`chunk ${i}@${off} FAILED ${String(e.message).slice(0,90)}`); return false; }
      await new Promise(r => setTimeout(r, 500 * (a + 1)));
    }
  }
};

let ok = 0;
for (let start = 0; start < nChunks; start += BATCH) {
  const idxs = [...Array(Math.min(BATCH, nChunks - start)).keys()].map(k => start + k);
  const res = await Promise.all(idxs.map(send));
  ok += res.filter(Boolean).length;
  console.log(`progress ${Math.min(start + BATCH, nChunks)}/${nChunks} ok=${ok}`);
}

await new Promise(r => setTimeout(r, 8000));
const info = await provider.connection.getAccountInfo(raw, "confirmed");
const idx = info.data.indexOf(local.subarray(0, 32));
const onchain = info.data.subarray(idx, idx + local.length);
const match = Buffer.compare(onchain, local) === 0;
console.log("MATCH:", match);
console.log("onchain sha256:", crypto.createHash("sha256").update(onchain).digest("hex").slice(0,32));
console.log("local   sha256:", crypto.createHash("sha256").update(local).digest("hex").slice(0,32));
if (!match) {
  let firstDiff = -1;
  for (let j = 0; j < local.length; j++) if (onchain[j] !== local[j]) { firstDiff = j; break; }
  console.log("first diff at", firstDiff, "chunk", Math.floor(firstDiff / CHUNK));
}
