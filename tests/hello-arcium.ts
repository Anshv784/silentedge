/**
 * The smallest real Arcium computation, end to end.
 *
 * Proves three things before any of this machinery is pointed at money:
 *
 *   1. the computation runs on an Arcium cluster, not locally — the result
 *      arrives through a callback the cluster signs, not from our own code;
 *   2. the input stays encrypted — `x` is never revealed to the program or the
 *      chain, only its ciphertext is;
 *   3. the result is correct — decrypting the callback payload gives x + 10.
 *
 * Requires a running cluster (`arcium localnet`, which needs Docker) or a
 * deployed MXE on devnet. Skipped otherwise rather than failing, so the rest of
 * the suite stays runnable without that dependency — see docs/arcium-hello-world.md.
 */

// Anchor 1.x ships a different TS client (@anchor-lang/core) from the 0.x line
// (@coral-xyz/anchor). Arcium 0.14 targets Anchor 1.x and its own scaffold uses
// @anchor-lang/core; driving an Arcium program with the 0.x client fails inside
// the provider with "Unknown action 'undefined'". The vault tests stay on
// @coral-xyz/anchor, which works for a plain Anchor program.
import * as anchor from "@anchor-lang/core";
import web3Pkg from "@solana/web3.js";
// @anchor-lang/core does not re-export BN the way @coral-xyz/anchor did.
import BN from "bn.js";

const { PublicKey, Keypair } = web3Pkg;
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  x25519,
} from "@arcium-hq/client";

const SECRET_X = 32n;
const PUBLIC_ADDEND = 10n; // baked into the circuit, not sent

describe("arcium — hello world", function () {
  this.timeout(1_200_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.HelloArcium as any;
  const arciumProgram = getArciumProgram(provider);

  const awaitEvent = async (eventName: string): Promise<any> => {
    let listenerId: number;
    const event = await new Promise<any>((res) => {
      listenerId = program.addEventListener(eventName as never, (e) => res(e));
    });
    await program.removeEventListener(listenerId!);
    return event;
  };

  it("computes x + 10 without revealing x", async function () {
    // Whatever wallet the provider is configured with — on devnet that is the
    // MXE authority, which is not necessarily ~/.config/solana/id.json.
    const owner = readKeypair(
      process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`
    );

    // No cluster reachable means no point pretending this passed.
    let arciumEnv: ReturnType<typeof getArciumEnv>;
    try {
      arciumEnv = getArciumEnv();
      await arciumProgram.account.mxeAccount.fetch(
        getMXEAccAddress(program.programId)
      );
    } catch (e) {
      console.log(
        "      no MXE reachable — start `arcium localnet` or deploy to devnet"
      );
      console.log("      reason:", e instanceof Error ? e.message.slice(0, 300) : String(e));
      this.skip();
      return;
    }
    const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

    await initAddTenCompDef(owner);

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider,
      program.programId
    );

    // Client side: ephemeral keypair, shared secret, fresh nonce.
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const cipher = new RescueCipher(
      x25519.getSharedSecret(privateKey, mxePublicKey)
    );
    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([SECRET_X], nonce);

    // The value itself must not appear in what we are about to send.
    const payload = Buffer.from(ciphertext[0]);
    const asLe = Buffer.alloc(8);
    asLe.writeBigUInt64LE(SECRET_X);
    expect(payload.includes(asLe), "x found in the ciphertext").to.equal(false);

    const eventPromise = awaitEvent("sumEvent");
    const computationOffset = new BN(randomBytes(8), "hex");

    const queueSig = await program.methods
      .addTen(
        computationOffset,
        Array.from(ciphertext[0]),
        Array.from(publicKey),
        new BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          computationOffset
        ),
        clusterAccount,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("add_ten")).readUInt32LE()
        ),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("      queued:", queueSig);

    // Nothing local computes the answer; this waits on the cluster.
    const finalizeSig = await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed"
    );
    console.log("      finalized:", finalizeSig);

    const event = await eventPromise;
    const decrypted = cipher.decrypt([event.sum], event.nonce)[0];
    expect(decrypted).to.equal(SECRET_X + PUBLIC_ADDEND);

    // The queue transaction carried ciphertext, never the value.
    const queueTx = await provider.connection.getTransaction(queueSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const txBlob = Buffer.from(JSON.stringify(queueTx));
    expect(txBlob.includes(asLe), "x as bytes in the queue transaction").to.equal(
      false
    );
  });

  async function initAddTenCompDef(owner: any): Promise<string> {
    const offset = getCompDefAccOffset("add_ten");
    const compDefPDA = PublicKey.findProgramAddressSync(
      [
        getArciumAccountBaseSeed("ComputationDefinitionAccount"),
        program.programId.toBuffer(),
        offset,
      ],
      getArciumProgramId()
    )[0];

    // Registering a circuit is three steps: create the account, upload the
    // bytes, finalize. The account existing says nothing about the other two —
    // skipping on existence alone leaves the definition unusable and queueing
    // fails later with ComputationDefinitionNotCompleted.
    const existing = await provider.connection.getAccountInfo(compDefPDA);
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);

    if (existing) {
      // Account is there; make sure the upload actually finished.
      await uploadCircuit(
        provider,
        "add_ten",
        program.programId,
        fs.readFileSync("build/add_ten.arcis"),
        true,
        900,
        { skipPreflight: true, commitment: "confirmed" }
      );
      return "already initialized";
    }

    const sig = await program.methods
      .initAddTenCompDef()
      .accountsPartial({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: getLookupTableAddress(
          program.programId,
          mxeAcc.lutOffsetSlot
        ),
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await uploadCircuit(
      provider,
      "add_ten",
      program.programId,
      fs.readFileSync("build/add_ten.arcis"),
      true,
      // Chunk size. Larger means fewer transactions, which matters a lot on a
      // rate-limited public RPC: the circuit is 62 KB.
      900,
      {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      }
    );
    return sig;
  }
});

async function getMXEPublicKeyWithRetry(
  provider: any,
  programId: any,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch {
      // Key material is published shortly after the MXE is created; retry.
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`MXE public key unavailable after ${maxRetries} attempts`);
}

function readKeypair(path: string): any {
  return Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
}
