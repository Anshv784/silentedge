/**
 * Persistent confidential strategy state.
 *
 * The property under test: a strategy encrypted to the MXE cluster survives
 * between computations and stays usable, without the plaintext ever existing
 * outside the MPC.
 *
 * That is what makes an unattended bot possible. `Enc<Shared, _>` is readable by
 * whoever submitted it, which is right for something a user just typed.
 * `Enc<Mxe, _>` is readable only by the cluster acting together — so later
 * evaluations can use the strategy with nobody online, and the stored bytes are
 * useless to the program, the operator, and the owner's own browser.
 *
 * Requires a live cluster. Skips otherwise rather than reporting a green tick
 * that proves nothing.
 */

import * as anchor from "@anchor-lang/core";
import web3Pkg from "@solana/web3.js";
import BN from "bn.js";
import { randomBytes } from "crypto";
import fs from "fs";
import { expect } from "chai";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumProgram,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  x25519,
} from "@arcium-hq/client";

const { PublicKey, Keypair } = web3Pkg;

/** The four values, in circuit field order. */
const STRATEGY = {
  entryBelow: 150_000_000n, // $150.00
  exitAbove: 180_500_000n, // $180.50
  stopBelow: 120_000_000n, // $120.00
  sizeBps: 1_000n, // 10%
};
const FIELDS = [
  STRATEGY.entryBelow,
  STRATEGY.exitAbove,
  STRATEGY.stopBelow,
  STRATEGY.sizeBps,
];

const STORED_STRATEGY_SEED = Buffer.from("stored_strategy");

describe("arcium — persistent strategy state", function () {
  this.timeout(1_200_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.HelloArcium as any;
  const arciumProgram = getArciumProgram(provider);

  const owner = readKeypair(
    process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`
  );
  const storedStrategyPda = PublicKey.findProgramAddressSync(
    [STORED_STRATEGY_SEED, owner.publicKey.toBuffer()],
    program.programId
  )[0];

  const awaitEvent = async (name: string): Promise<any> => {
    let id: number;
    const ev = await new Promise<any>((res) => {
      id = program.addEventListener(name as never, (e: any) => res(e));
    });
    await program.removeEventListener(id!);
    return ev;
  };

  let env: ReturnType<typeof getArciumEnv>;
  let mxePublicKey: Uint8Array;

  before(async function () {
    try {
      env = getArciumEnv();
      await arciumProgram.account.mxeAccount.fetch(
        getMXEAccAddress(program.programId)
      );
      mxePublicKey = await getMXEPublicKey(provider, program.programId);
    } catch {
      console.log("      no MXE reachable — skipping");
      this.skip();
    }
  });

  it("stores a strategy as MXE-encrypted state, then reads it back in a later computation", async () => {
    // --- create the account the callback will write into -----------------
    // Accounts cannot be created inside an Arcium callback, so this is a
    // separate, ordinary transaction.
    if (!(await provider.connection.getAccountInfo(storedStrategyPda))) {
      await program.methods
        .initStoredStrategy()
        .accountsPartial({
          owner: owner.publicKey,
          storedStrategy: storedStrategyPda,
          systemProgram: web3Pkg.SystemProgram.programId,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
    }

    // --- 1. encrypt to a shared secret, as the browser would -------------
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const cipher = new RescueCipher(
      x25519.getSharedSecret(privateKey, mxePublicKey)
    );
    const nonce = randomBytes(16);
    const ciphertexts = cipher.encrypt(FIELDS, nonce);

    // The values must not be recoverable from what we are about to send.
    const payload = Buffer.concat(ciphertexts.map((c: number[]) => Buffer.from(c)));
    for (const v of FIELDS) {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(v);
      expect(payload.includes(le), `${v} present in ciphertext`).to.equal(false);
    }

    // --- 2. hand it to the cluster to re-encrypt as Enc<Mxe, Strategy> ---
    const storedEvent = awaitEvent("strategyStored");
    const storeOffset = new BN(randomBytes(8), "hex");
    const storeSig = await program.methods
      .storeStrategy(
        storeOffset,
        ciphertexts.map((c: number[]) => Array.from(c)),
        Array.from(publicKey),
        new BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        payer: owner.publicKey,
        storedStrategy: storedStrategyPda,
        owner: owner.publicKey,
        computationAccount: getComputationAccAddress(
          env.arciumClusterOffset,
          storeOffset
        ),
        clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("store_strategy")).readUInt32LE()
        ),
      })
      .signers([owner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("      store queued:", storeSig.slice(0, 24) + "…");

    await awaitComputationFinalization(
      provider,
      storeOffset,
      program.programId,
      "confirmed"
    );
    await storedEvent;

    // --- 3. the account now holds ciphertext, and only ciphertext --------
    const stored = await program.account.storedStrategy.fetch(storedStrategyPda);
    expect(stored.version).to.equal(1);
    expect(stored.ciphertexts).to.have.length(4);

    const account = await provider.connection.getAccountInfo(storedStrategyPda);
    for (const v of FIELDS) {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(v);
      expect(
        account!.data.includes(le),
        `${v} found in the stored account`
      ).to.equal(false);
      expect(
        account!.data.includes(Buffer.from(v.toString())),
        `${v} as text in the stored account`
      ).to.equal(false);
    }

    // Nothing on the client can decrypt Enc<Mxe, _> — there is no shared
    // secret for it. The submitter's own key is now useless against this data.
    expect(
      (stored as any).encryptionKey,
      "MXE state must carry no client key"
    ).to.equal(undefined);

    // --- 4. a LATER computation reads that state back --------------------
    // This is the point of the test: different computation, different nonce,
    // different ephemeral key — and the state written earlier is still usable.
    const readerPrivate = x25519.utils.randomSecretKey();
    const readerPublic = x25519.getPublicKey(readerPrivate);
    const readerCipher = new RescueCipher(
      x25519.getSharedSecret(readerPrivate, mxePublicKey)
    );
    const readerNonce = randomBytes(16);

    const readEvent = awaitEvent("strategyRead");
    const readOffset = new BN(randomBytes(8), "hex");
    const readSig = await program.methods
      .exportStrategy(
        readOffset,
        Array.from(readerPublic),
        new BN(deserializeLE(readerNonce).toString())
      )
      .accountsPartial({
        payer: owner.publicKey,
        storedStrategy: storedStrategyPda,
        computationAccount: getComputationAccAddress(
          env.arciumClusterOffset,
          readOffset
        ),
        clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("export_strategy")).readUInt32LE()
        ),
      })
      .signers([owner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("      read queued: ", readSig.slice(0, 24) + "…");

    await awaitComputationFinalization(
      provider,
      readOffset,
      program.programId,
      "confirmed"
    );
    const ev = await readEvent;

    // --- 5. it decrypts to exactly what was stored -----------------------
    const recovered = readerCipher.decrypt(ev.ciphertexts, ev.nonce);
    expect(recovered.map(String)).to.deep.equal(FIELDS.map(String));
    console.log("      recovered:", recovered.map(String).join(", "));
  });
});

function readKeypair(path: string): any {
  return Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
}
