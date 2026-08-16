/**
 * Confidential strategy evaluation, driven by a real oracle price.
 *
 * The price is read on chain from Pyth, so these tests cannot name one. Each
 * scenario instead stores a strategy whose thresholds are positioned around
 * whatever SOL is actually worth right now, and asserts the decision that
 * follows. A test that could choose the price would not be testing the oracle
 * path at all.
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

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const fmt = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;

const NEVER_BUY = 0n;
const NEVER_SELL = 18_446_744_073_709_551_615n; // u64::MAX

/** Public vault setting now, not an encrypted field — THREAT_MODEL T-38. */
const SIZE_BPS = 1_000; // 10%
const VAULT_VALUE = 2_500_000_000n; // 2,500 USDC in base units
const EXPECTED_SIZED = (VAULT_VALUE * BigInt(SIZE_BPS)) / 10_000n;

const STORED_STRATEGY_SEED = Buffer.from("stored_strategy");

/** Pyth's sponsored SOL/USD price update account on devnet. */
const PYTH_SOL_USD_DEVNET = new PublicKey(
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

describe("arcium — confidential strategy evaluation", function () {
  this.timeout(600_000);

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
      await arciumProgram.account.mxeAccount.fetch(getMXEAccAddress(program.programId));
      mxePublicKey = await getMXEPublicKey(provider, program.programId);
    } catch {
      console.log("      no MXE reachable — skipping");
      this.skip();
      return;
    }
    if (!(await provider.connection.getAccountInfo(storedStrategyPda))) {
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
  });

  /** Decode the oracle exactly the way the program scales it. */
  async function livePrice(): Promise<bigint> {
    const info = await provider.connection.getAccountInfo(PYTH_SOL_USD_DEVNET);
    const d = info!.data;
    const off = 8 + 32 + 1 + 32; // discriminator, write authority, verification level, feed id
    const raw = d.readBigInt64LE(off);
    const expo = d.readInt32LE(off + 16);
    const shift = expo + 6;
    return shift >= 0 ? raw * 10n ** BigInt(shift) : raw / 10n ** BigInt(-shift);
  }

  async function storeStrategy(fields: bigint[]) {
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxePublicKey));
    const nonce = randomBytes(16);
    const cts = cipher.encrypt(fields, nonce);
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

  async function evaluate(priceUpdate: any = PYTH_SOL_USD_DEVNET) {
    const evaluated = awaitEvent("strategyEvaluated");
    const offset = new BN(randomBytes(8), "hex");
    const sig = await program.methods
      .evaluateStrategy(offset, new BN(VAULT_VALUE.toString()))
      .accountsPartial({
        payer: owner.publicKey,
        storedStrategy: storedStrategyPda,
        priceUpdate,
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
    return { action: ev.action as number, amount: BigInt(ev.amount.toString()), sig };
  }

  it("reads a live, validated SOL/USD price", async () => {
    const price = await livePrice();
    console.log(`      live SOL/USD: ${fmt(price)}`);
    // The program's own sanity band.
    expect(price > usd(1), "below the sanity floor").to.equal(true);
    expect(price < usd(10_000), "above the sanity ceiling").to.equal(true);
  });

  it("buys when the live price is below the entry threshold", async () => {
    const p = await livePrice();
    await storeStrategy([p + usd(10), NEVER_SELL, NEVER_BUY]);
    const r = await evaluate();
    console.log(`      entry ${fmt(p + usd(10))}, live ${fmt(p)} -> action ${r.action}`);
    expect(r.action).to.equal(BUY);
    expect(r.amount).to.equal(EXPECTED_SIZED);
  });

  it("holds when the live price sits between the thresholds", async () => {
    const p = await livePrice();
    await storeStrategy([p - usd(10), p + usd(10), p - usd(20)]);
    const r = await evaluate();
    console.log(`      band ${fmt(p - usd(10))}..${fmt(p + usd(10))} -> action ${r.action}`);
    expect(r.action).to.equal(HOLD);
    expect(r.amount).to.equal(0n);
  });

  it("sells when the live price is above the exit threshold", async () => {
    const p = await livePrice();
    await storeStrategy([NEVER_BUY, p - usd(10), NEVER_BUY]);
    const r = await evaluate();
    console.log(`      exit ${fmt(p - usd(10))}, live ${fmt(p)} -> action ${r.action}`);
    expect(r.action).to.equal(SELL);
    expect(r.amount).to.equal(EXPECTED_SIZED);
  });

  /** A stop is an exit, not an entry, even though it is also below the buy price. */
  it("stops out below the stop threshold, exiting the whole position", async () => {
    const p = await livePrice();
    await storeStrategy([p + usd(10), NEVER_SELL, p + usd(5)]);
    const r = await evaluate();
    console.log(`      stop ${fmt(p + usd(5))}, live ${fmt(p)} -> action ${r.action}`);
    expect(r.action).to.equal(SELL);
    expect(r.amount).to.equal(VAULT_VALUE);
  });

  /**
   * The oracle account is not a free parameter. `Account<PriceUpdateV2>` enforces
   * ownership by the Pyth receiver, so an arbitrary account cannot be swapped in
   * to fake a price.
   */
  it("rejects a price account that is not a Pyth price update", async () => {
    // Simulated rather than sent. Anchor wraps send failures in a
    // SendTransactionError that a second copy of @solana/web3.js re-raises as
    // "Unknown action 'undefined'", which would let this pass on any error at
    // all. Simulation returns the program's real logs.
    const offset = new BN(randomBytes(8), "hex");
    const ix = await program.methods
      .evaluateStrategy(offset, new BN(VAULT_VALUE.toString()))
      .accountsPartial({
        payer: owner.publicKey,
        storedStrategy: storedStrategyPda,
        priceUpdate: storedStrategyPda, // our own account: wrong owner
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
      .instruction();

    const tx = new web3Pkg.Transaction().add(ix);
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;

    const sim = await provider.connection.simulateTransaction(tx);
    expect(sim.value.err, "a non-Pyth price account was accepted").to.not.equal(null);

    const logs = (sim.value.logs ?? []).join("\n");
    expect(
      logs,
      `expected an ownership rejection, got: ${logs.slice(0, 300)}`
    ).to.match(/AccountOwnedByWrongProgram|ConstraintOwner|owned by the wrong program/i);
  });

  /** Thresholds must not appear in the real bytes the chain stores. */
  it("puts no threshold on chain", async () => {
    const p = await livePrice();
    const entry = p + usd(10);
    await storeStrategy([entry, NEVER_SELL, NEVER_BUY]);
    const r = await evaluate();

    const tx = await provider.connection.getTransaction(r.sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    // Serialize the message rather than stringifying the response object. In
    // JSON, instruction data is base58 — searching that for raw little-endian
    // bytes finds nothing, so the assertion would pass whether or not the
    // secret was present.
    const blob = Buffer.concat([
      Buffer.from(tx!.transaction.message.serialize()),
      Buffer.from((tx!.meta?.logMessages ?? []).join("\n")),
    ]);

    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(entry);
    expect(blob.includes(le), "entry threshold as bytes on chain").to.equal(false);
    expect(
      blob.includes(Buffer.from(entry.toString())),
      "entry threshold as text on chain"
    ).to.equal(false);

    // Positive control: vault_value IS an argument, so it must be findable.
    // Without this the assertions above could pass simply because nothing is
    // encoded the way we are searching for.
    const vv = Buffer.alloc(8);
    vv.writeBigUInt64LE(VAULT_VALUE);
    expect(blob.includes(vv), "vault_value should be present").to.equal(true);
  });
});

function readKeypair(path: string): any {
  return Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
}
