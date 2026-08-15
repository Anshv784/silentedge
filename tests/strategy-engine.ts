/**
 * Confidential strategy evaluation.
 *
 * A private strategy meets a public price inside MPC and only the resulting
 * action comes back. This test drives every branch and then checks what the
 * chain actually learned.
 *
 * Requires a live cluster. Skips otherwise.
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

const { PublicKey, Keypair, SystemProgram } = web3Pkg;

const HOLD = 0;
const BUY = 1;
const SELL = 2;

/** Prices are fixed-point with 6 decimals, matching PRICE_DECIMALS. */
const usd = (n: number) => BigInt(Math.round(n * 1e6));

const ENTRY_BELOW = usd(150);
const EXIT_ABOVE = usd(180.5);
const STOP_BELOW = usd(120);
const SIZE_BPS = 1_000n; // 10%

const VAULT_VALUE = 2_500_000_000n; // 2,500 USDC in base units
const EXPECTED_SIZED = (VAULT_VALUE * SIZE_BPS) / 10_000n;

const STORED_STRATEGY_SEED = Buffer.from("stored_strategy");

describe("arcium — confidential strategy evaluation", function () {
  this.timeout(420_000);

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

  before(async function () {
    try {
      env = getArciumEnv();
      await arciumProgram.account.mxeAccount.fetch(
        getMXEAccAddress(program.programId)
      );
    } catch {
      console.log("      no MXE reachable — skipping");
      this.skip();
      return;
    }

    // Ensure a strategy is stored. Reuses the one from the state test if present.
    const existing = await provider.connection.getAccountInfo(storedStrategyPda);
    if (!existing) {
      await program.methods
        .initStoredStrategy()
        .accountsPartial({
          owner: owner.publicKey,
          storedStrategy: storedStrategyPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
    }
    const stored = await program.account.storedStrategy.fetch(storedStrategyPda);
    if (stored.version === 0) {
      const mxePublicKey = await getMXEPublicKey(provider, program.programId);
      const priv = x25519.utils.randomSecretKey();
      const pub = x25519.getPublicKey(priv);
      const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxePublicKey));
      const nonce = randomBytes(16);
      const cts = cipher.encrypt(
        [ENTRY_BELOW, EXIT_ABOVE, STOP_BELOW, SIZE_BPS],
        nonce
      );
      const off = new BN(randomBytes(8), "hex");
      await program.methods
        .storeStrategy(
          off,
          cts.map((c: number[]) => Array.from(c)),
          Array.from(pub),
          new BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          payer: owner.publicKey,
          storedStrategy: storedStrategyPda,
          owner: owner.publicKey,
          computationAccount: getComputationAccAddress(env.arciumClusterOffset, off),
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
      await awaitComputationFinalization(provider, off, program.programId, "confirmed");
    }
  });

  /** Queue one evaluation and return the revealed decision plus the queue signature. */
  async function evaluate(price: bigint) {
    const evaluated = awaitEvent("strategyEvaluated");
    const offset = new BN(randomBytes(8), "hex");
    const sig = await program.methods
      .evaluateStrategy(
        offset,
        new BN(price.toString()),
        new BN(VAULT_VALUE.toString())
      )
      .accountsPartial({
        payer: owner.publicKey,
        storedStrategy: storedStrategyPda,
        computationAccount: getComputationAccAddress(env.arciumClusterOffset, offset),
        clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("evaluate_strategy")).readUInt32LE()
        ),
      })
      .signers([owner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await awaitComputationFinalization(provider, offset, program.programId, "confirmed");
    const ev = await evaluated;
    return {
      action: ev.action as number,
      amount: BigInt(ev.amount.toString()),
      sig,
    };
  }

  it("buys below the entry threshold", async () => {
    const r = await evaluate(usd(140));
    console.log(`      price 140 -> action ${r.action}, amount ${r.amount}`);
    expect(r.action).to.equal(BUY);
    expect(r.amount).to.equal(EXPECTED_SIZED);
  });

  it("holds between the thresholds", async () => {
    const r = await evaluate(usd(165));
    console.log(`      price 165 -> action ${r.action}, amount ${r.amount}`);
    expect(r.action).to.equal(HOLD);
    expect(r.amount).to.equal(0n);
  });

  it("sells above the exit threshold", async () => {
    const r = await evaluate(usd(190));
    console.log(`      price 190 -> action ${r.action}, amount ${r.amount}`);
    expect(r.action).to.equal(SELL);
    expect(r.amount).to.equal(EXPECTED_SIZED);
  });

  /** A stop is an exit, not an entry, even though it is also below the buy price. */
  it("stops out below the stop threshold, exiting the whole position", async () => {
    const r = await evaluate(usd(110));
    console.log(`      price 110 -> action ${r.action}, amount ${r.amount}`);
    expect(r.action).to.equal(SELL);
    expect(r.amount).to.equal(VAULT_VALUE);
  });

  /**
   * What the chain learned.
   *
   * The queueing transaction necessarily carries the public price. What it must
   * not carry is any threshold — those exist only as ciphertext in the stored
   * account and as secret shares inside the MPC.
   */
  it("puts no threshold on chain", async () => {
    const r = await evaluate(usd(140));
    const tx = await provider.connection.getTransaction(r.sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    // Serialize the message rather than stringifying the response object.
    // In JSON, instruction data is base58 — searching that for raw
    // little-endian bytes finds nothing, so every "secret is absent" assertion
    // would pass whether or not the secret was actually there.
    const blob = Buffer.concat([
      Buffer.from(tx!.transaction.message.serialize()),
      Buffer.from((tx!.meta?.logMessages ?? []).join("\n")),
    ]);

    for (const [name, secret] of [
      ["entry_below", ENTRY_BELOW],
      ["exit_above", EXIT_ABOVE],
      ["stop_below", STOP_BELOW],
    ] as const) {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(secret);
      expect(blob.includes(le), `${name} as bytes on chain`).to.equal(false);
      expect(
        blob.includes(Buffer.from(secret.toString())),
        `${name} as text on chain`
      ).to.equal(false);
    }

    // Sanity: the public price IS there, so the search looked in the right place.
    const priceLe = Buffer.alloc(8);
    priceLe.writeBigUInt64LE(usd(140));
    expect(blob.includes(priceLe), "public price should be present").to.equal(true);
  });
});

function readKeypair(path: string): any {
  return Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
}
