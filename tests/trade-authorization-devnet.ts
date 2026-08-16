/**
 * Trade authorization, end to end against the live Arcium devnet cluster.
 *
 * The structural tests prove nothing *else* can authorize a trade. This proves
 * the one thing that can — a callback whose BLS signature verified against the
 * pinned cluster — actually does, and that the resulting authorization is
 * bounded the way it claims.
 *
 * Requires a deployed vault MXE. Skips otherwise.
 */

import * as anchor from "@anchor-lang/core";
import web3Pkg from "@solana/web3.js";
import BN from "bn.js";
import { randomBytes } from "crypto";
import fs from "fs";
import { expect } from "chai";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  getArciumEnv, getCompDefAccOffset, getArciumProgram,
  RescueCipher, deserializeLE, getMXEPublicKey, getMXEAccAddress, getMempoolAccAddress,
  getCompDefAccAddress, getExecutingPoolAccAddress, getComputationAccAddress,
  getClusterAccAddress, x25519,
} from "@arcium-hq/client";

const { PublicKey, Keypair, SystemProgram } = web3Pkg;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const BASE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const QUOTE_MINT = new PublicKey("36X5x8D8jc15XD971iSC9cAB5puaA7zXc6dggA96rxbw");
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const JUPITER_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

const VAULT_SEED = Buffer.from("vault");
const STRATEGY_SEED = Buffer.from("strategy");
const INTENT_SEED = Buffer.from("intent");

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const fmt = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;
const NEVER_SELL = 18_446_744_073_709_551_615n;
const NEVER_BUY = 0n;
/** Public vault setting now, not an encrypted field — THREAT_MODEL T-38. */
const SIZE_BPS = 1_000;
/** Funds the vault so a sized trade is non-zero. 10% of this is the trade. */
const DEPOSIT = usd(5_000);
/** Wrapped SOL for the sell branches. Small: devnet SOL is not replaceable. */
const EXIT_TEST_BASE = 20_000_000n; // 0.02 SOL
const FINALIZE_TIMEOUT_MS = 240_000;

describe("vault — authorization on devnet", function () {
  this.timeout(900_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as any;
  const arciumProgram = getArciumProgram(provider);

  const payer = readKeypair(process.env.ANCHOR_WALLET!);
  /**
   * A wallet that has never existed before this run, funded from the payer.
   *
   * This suite used to run as the payer itself, which made it depend on the
   * history of one long-lived devnet wallet: that wallet's vault was created
   * before two account-layout changes and now fails to deserialize, so the
   * whole file died in `before all` with error 3003 through no fault of the
   * code under test. A vault created this run is always the current layout.
   *
   * `tests/e2e-devnet.ts` already did it this way. The cost is a few cents of
   * devnet rent per run, and the benefit is a suite whose result depends only
   * on the program.
   */
  const owner = Keypair.generate();
  const vault = PublicKey.findProgramAddressSync(
    [VAULT_SEED, owner.publicKey.toBuffer()], program.programId)[0];
  const strategyPda = PublicKey.findProgramAddressSync(
    [STRATEGY_SEED, vault.toBuffer()], program.programId)[0];
  const intentPda = PublicKey.findProgramAddressSync(
    [INTENT_SEED, vault.toBuffer()], program.programId)[0];

  const ata = (o: any, m: any, off = false) => {
    const [a] = PublicKey.findProgramAddressSync(
      [o.toBuffer(), TOKEN_PROGRAM.toBuffer(), m.toBuffer()], ATA_PROGRAM);
    return a;
  };

  /**
   * Poll until a queued computation has visibly taken effect on chain.
   *
   * `awaitComputationFinalization` listens on a websocket subscription, and a
   * dropped subscription leaves it waiting forever — the callback lands, the
   * state changes, and the test hangs anyway. That is not hypothetical; it hung
   * a full run here. Waiting on the state change the callback *causes* needs no
   * subscription and asserts something stronger: not that a computation
   * finished, but that it did what it was supposed to do.
   */
  const settle = async (label: string, done: () => Promise<boolean>) => {
    const deadline = Date.now() + FINALIZE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Devnet RPC drops connections; a transient failure is not a verdict.
      if (await done().catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`${label}: no on-chain effect within ${FINALIZE_TIMEOUT_MS}ms`);
  };


  /**
   * Build, simulate, then send raw.
   *
   * `@anchor-lang/core`'s `.rpc()` reports on-chain failures here as
   * `Unknown action 'undefined'`, which names neither the instruction nor the
   * error — a test that fails this way tells you nothing. Simulating first
   * surfaces the AnchorError line; sending raw afterwards avoids the wrapper
   * entirely.
   */
  async function send(builder: any, label: string) {
    const tx = await builder.transaction();
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    tx.sign(owner);
    const sim = await provider.connection.simulateTransaction(tx);
    if (sim.value.err) {
      const why = (sim.value.logs || []).filter((l: string) => /Error/.test(l));
      throw new Error(`${label}: ${JSON.stringify(sim.value.err)} :: ${why.join(" | ")}`);
    }
    const sig = await provider.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    await provider.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  let env: any;
  let mxePublicKey: Uint8Array;

  before(async function () {
    try {
      env = getArciumEnv();
      await arciumProgram.account.mxeAccount.fetch(getMXEAccAddress(program.programId));
      mxePublicKey = await getMXEPublicKey(provider, program.programId);
    } catch (e) {
      // Say why. A silent skip reads as "covered" in a test log, which is the
      // one thing this suite must never imply.
      console.log(`      no vault MXE reachable — skipping: ${e}`);
      this.skip();
      return;
    }

    // Rent and fees for a wallet that starts with nothing.
    await web3Pkg.sendAndConfirmTransaction(
      provider.connection,
      new web3Pkg.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: owner.publicKey,
          lamports: 150_000_000,
        })
      ),
      [payer],
      { commitment: "confirmed" }
    );

    if (!(await provider.connection.getAccountInfo(vault))) {
      await program.methods.initializeVault({
        maxTradeBps: 1_000, maxSlippageBps: 50, dailyLossLimitBps: 500,
        cooldownSeconds: 60, maxOracleStalenessSec: 30, maxConfBps: 100,
        maxOracleDeviationBps: 200, sizeBps: 1_000,
      }).accountsPartial({
        owner: owner.publicKey, vaultConfig: vault,
        baseMint: BASE_MINT, quoteMint: QUOTE_MINT,
        vaultBaseAta: ata(vault, BASE_MINT, true),
        vaultQuoteAta: ata(vault, QUOTE_MINT, true),
        tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM,
        systemProgram: SystemProgram.programId,
      }).signers([owner]).rpc({ commitment: "confirmed" });
      console.log("      vault created:", vault.toBase58());
    }
    if (!(await provider.connection.getAccountInfo(intentPda))) {
      await program.methods.initTradeIntent().accountsPartial({
        owner: owner.publicKey, vaultConfig: vault, tradeIntent: intentPda,
        systemProgram: SystemProgram.programId,
      }).signers([owner]).rpc({ commitment: "confirmed" });
    }

    // The circuit sizes a trade from the vault's quote balance, so an empty
    // vault evaluates every strategy to a zero-sized trade and the positive
    // authorization path never runs. Fund it through the real deposit path.
    const vaultQuote = ata(vault, QUOTE_MINT, true);
    const bal = await provider.connection
      .getTokenAccountBalance(vaultQuote)
      .catch(() => null);
    if (!bal || BigInt(bal.value.amount) === 0n) {
      // Mint the test quote asset to the fresh owner first — the mint
      // authority is the payer, and nothing else on devnet will hand it out.
      const ownerQuote = await getOrCreateAssociatedTokenAccount(
        provider.connection, payer, QUOTE_MINT, owner.publicKey
      );
      await mintTo(
        provider.connection, payer, QUOTE_MINT, ownerQuote.address,
        payer, Number(DEPOSIT)
      );
      await program.methods.deposit(new BN(DEPOSIT.toString())).accountsPartial({
        owner: owner.publicKey, vaultConfig: vault, mint: QUOTE_MINT,
        ownerAta: ata(owner.publicKey, QUOTE_MINT), vaultAta: vaultQuote,
        tokenProgram: TOKEN_PROGRAM,
      }).signers([owner]).rpc({ commitment: "confirmed" });
      console.log(`      deposited ${fmt(DEPOSIT)}`);
    }
  });

  async function livePrice(): Promise<bigint> {
    const d = (await provider.connection.getAccountInfo(PYTH_SOL_USD))!.data;
    const off = 8 + 32 + 1 + 32;
    const raw = d.readBigInt64LE(off);
    const shift = d.readInt32LE(off + 16) + 6;
    return shift >= 0 ? raw * 10n ** BigInt(shift) : raw / 10n ** BigInt(-shift);
  }

  /** Submit a strategy, then have the cluster re-encrypt it to Enc<Mxe, _>. */
  async function submitAndConvert(fields: bigint[]) {
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxePublicKey));
    const nonce = randomBytes(16);
    const cts = cipher.encrypt(fields, nonce);

    await send(program.methods.submitStrategy(
      cts.map((c: number[]) => Array.from(c)),
      new BN(deserializeLE(nonce).toString()),
      Array.from(pub)
    ).accountsPartial({
      owner: owner.publicKey, vaultConfig: vault, strategyState: strategyPda,
      systemProgram: SystemProgram.programId,
    }), "submit_strategy");

    const off = new BN(randomBytes(8), "hex");
    await send(program.methods.convertStrategy(off).accountsPartial({
      payer: owner.publicKey, vaultConfig: vault, strategyState: strategyPda,
      computationAccount: getComputationAccAddress(env.arciumClusterOffset, off),
      clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(program.programId,
        Buffer.from(getCompDefAccOffset("store_strategy_v2")).readUInt32LE()),
    }), "convert_strategy");
    // The *ciphertext* appearing is the callback's effect, and it is the only
    // unambiguous one. `mxeVersion` goes non-zero when convert_strategy queues
    // the computation — waiting on that returned immediately and every later
    // test then failed with StrategyNotConverted against a strategy that was
    // still converting.
    await settle("convert_strategy", async () => {
      const st = await program.account.strategyState.fetch(strategyPda);
      const armed = (st.mxeCiphertexts as number[][]).some((c: number[]) =>
        c.some((b: number) => b !== 0)
      );
      return armed && st.mxeVersion > 0;
    });
  }

  /**
   * Did a callback actually execute since `slot`?
   *
   * "Nothing changed" is the expected result for HOLD, and it is also what a
   * callback that reverted looks like. Without this the HOLD case passes
   * whether the program worked or not.
   */
  async function sawCallbackSince(slot: number): Promise<boolean> {
    const sigs = await provider.connection.getSignaturesForAddress(
      program.programId, { limit: 25 }, "confirmed");
    for (const s of sigs) {
      if ((s.slot ?? 0) < slot || s.err) continue;
      const tx = await provider.connection.getTransaction(s.signature, {
        commitment: "confirmed", maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages?.some((l) => l.includes("EvaluateStrategyV3Callback")))
        return true;
    }
    return false;
  }

  async function evaluate() {
    const startSlot = await provider.connection.getSlot("confirmed");
    const off = new BN(randomBytes(8), "hex");
    await send(program.methods.evaluateStrategy(off).accountsPartial({
      payer: owner.publicKey, vaultConfig: vault, strategyState: strategyPda,
      tradeIntent: intentPda, vaultQuoteAta: ata(vault, QUOTE_MINT, true),
      vaultBaseAta: ata(vault, BASE_MINT, true), priceUpdate: PYTH_SOL_USD,
      computationAccount: getComputationAccAddress(env.arciumClusterOffset, off),
      clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(program.programId,
        Buffer.from(getCompDefAccOffset("evaluate_strategy_v3")).readUInt32LE()),
    }), "evaluate_strategy");
    await settle("evaluate_strategy", () => sawCallbackSince(startSlot));
    return program.account.tradeIntent.fetch(intentPda);
  }

  /**
   * Put a little wrapped SOL in the vault so a sell has something to sell.
   *
   * The circuit sizes a sell from `base_value`, so with an empty base balance
   * every sell branch returns amount 0 and the callback writes no intent —
   * which is indistinguishable from the branch not firing. Without this, a
   * SELL test would pass for the wrong reason.
   */
  async function ensureBase(min: bigint): Promise<bigint> {
    const vaultBase = ata(vault, BASE_MINT, true);
    const held = await provider.connection
      .getTokenAccountBalance(vaultBase)
      .then((r: any) => BigInt(r.value.amount))
      .catch(() => 0n);
    if (held >= min) return held;

    const ownerBase = ata(owner.publicKey, BASE_MINT);
    const need = min - held;
    const tx = new web3Pkg.Transaction().add(
      // Idempotent: the ATA usually exists by the second run.
      new web3Pkg.TransactionInstruction({
        programId: ATA_PROGRAM,
        keys: [
          { pubkey: owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: ownerBase, isSigner: false, isWritable: true },
          { pubkey: owner.publicKey, isSigner: false, isWritable: false },
          { pubkey: BASE_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // CreateIdempotent
      }),
      SystemProgram.transfer({
        fromPubkey: owner.publicKey, toPubkey: ownerBase,
        lamports: Number(need),
      }),
      // SyncNative — makes the lamports show up as a token balance.
      new web3Pkg.TransactionInstruction({
        programId: TOKEN_PROGRAM,
        keys: [{ pubkey: ownerBase, isSigner: false, isWritable: true }],
        data: Buffer.from([17]),
      })
    );
    await provider.sendAndConfirm(tx, [owner], { commitment: "confirmed" });

    await program.methods.deposit(new BN(need.toString())).accountsPartial({
      owner: owner.publicKey, vaultConfig: vault, mint: BASE_MINT,
      ownerAta: ownerBase, vaultAta: vaultBase, tokenProgram: TOKEN_PROGRAM,
    }).signers([owner]).rpc({ commitment: "confirmed" });

    const after = await provider.connection
      .getTokenAccountBalance(vaultBase)
      .then((r: any) => BigInt(r.value.amount));
    expect(after >= min, "vault must actually hold base for a sell to be meaningful")
      .to.equal(true);
    return after;
  }

  it("converts the submitted strategy to MXE-encrypted state", async () => {
    const p = await livePrice();
    await submitAndConvert([p + usd(10), NEVER_SELL, NEVER_BUY]);
    const s = await program.account.strategyState.fetch(strategyPda);
    expect(s.mxeVersion).to.be.greaterThan(0);
    console.log(`      converted, mxe_version ${s.mxeVersion}`);
  });

  /** A verified callback is the only thing that can produce an authorization. */
  it("writes a bounded authorization from a verified callback", async () => {
    const p = await livePrice();
    const intent = await evaluate();
    console.log(`      live ${fmt(p)} -> side ${intent.side}, amount ${intent.amountIn}`);

    expect(intent.side, "expected a BUY authorization").to.equal(1);
    expect(intent.consumed).to.equal(false);
    expect(Number(intent.amountIn)).to.be.greaterThan(0);

    // Bounded, not open-ended.
    const slot = await provider.connection.getSlot("confirmed");
    expect(Number(intent.expiresAtSlot)).to.be.greaterThan(slot);
    expect(Number(intent.expiresAtSlot) - slot).to.be.lessThanOrEqual(180);

    const v = await program.account.vaultConfig.fetch(vault);
    expect(intent.vaultNonce.toString()).to.equal(v.nonce.toString());
    const s = await program.account.strategyState.fetch(strategyPda);
    expect(intent.strategyVersion).to.equal(s.mxeVersion);
  });

  /** HOLD authorizes nothing — a missing intent and "do not trade" are one state. */
  it("authorizes nothing when the strategy says HOLD", async () => {
    const p = await livePrice();
    await submitAndConvert([p - usd(20), p + usd(20), p - usd(30)]);
    const before = await program.account.tradeIntent.fetch(intentPda);
    const intent = await evaluate();
    console.log(`      band ${fmt(p - usd(20))}..${fmt(p + usd(20))} -> no new authorization`);
    // Unchanged: the callback returned early without touching the intent.
    expect(intent.amountIn.toString()).to.equal(before.amountIn.toString());
    expect(intent.expiresAtSlot.toString()).to.equal(before.expiresAtSlot.toString());
  });

  /**
   * The take-profit branch. `tests/strategy-engine.ts` used to cover this
   * against an interface that no longer exists — `evaluate_strategy` took the
   * vault's value as a caller argument back then, which is exactly the lie the
   * current design removed. Ported here rather than dropped: nothing else
   * exercises a sell, and a strategy engine whose only tested branch is "buy"
   * is half tested.
   */
  it("authorizes a sell when the price is above the exit threshold", async () => {
    const p = await livePrice();
    const held = await ensureBase(EXIT_TEST_BASE);
    // Exit above a price the market is already past, and an entry that can
    // never fire, so only the sell branch can produce this.
    await submitAndConvert([NEVER_BUY, p - usd(10), NEVER_BUY]);

    const intent = await evaluate();
    console.log(`      live ${fmt(p)} > exit ${fmt(p - usd(10))} -> side ${intent.side}, ${intent.amountIn} lamports`);

    expect(intent.side, "expected a SELL authorization").to.equal(2);
    expect(intent.consumed).to.equal(false);

    // Sized from the base balance, not the quote balance. Sizing a sell off
    // the quote side is the specific defect this assertion exists to catch:
    // it asks a SOL sale to be denominated in USDC.
    const expected = (held * BigInt(SIZE_BPS)) / 10_000n;
    expect(intent.amountIn.toString(),
      "a sell must be sized from the base balance").to.equal(expected.toString());
  });

  /**
   * The stop-loss branch, and the one asymmetry in the circuit: a stop exits
   * the *whole* position rather than the configured fraction.
   */
  it("exits the whole position when the stop is hit", async () => {
    const p = await livePrice();
    const held = await ensureBase(EXIT_TEST_BASE);
    // Stop above the live price fires; the entry below it would also fire, and
    // must lose — a price under the stop is under the entry too, and reading
    // that as a buy would have the vault double down on the way out.
    await submitAndConvert([p + usd(10), NEVER_SELL, p + usd(5)]);

    const intent = await evaluate();
    console.log(`      live ${fmt(p)} < stop ${fmt(p + usd(5))} -> side ${intent.side}, ${intent.amountIn} lamports`);

    expect(intent.side, "a stop must sell, never buy").to.equal(2);
    expect(intent.amountIn.toString(),
      "a stop exits the whole position, not a fraction").to.equal(held.toString());
  });

  /** Replacing the strategy must invalidate an authorization still in flight. */
  it("invalidates an in-flight authorization when the strategy changes", async () => {
    const p = await livePrice();
    await submitAndConvert([p + usd(10), NEVER_SELL, NEVER_BUY]);
    const intent = await evaluate();
    expect(intent.side).to.equal(1);
    const authorizedVersion = intent.strategyVersion;

    // A new submission bumps the version the intent was bound to.
    await submitAndConvert([p + usd(15), NEVER_SELL, NEVER_BUY]);
    const s = await program.account.strategyState.fetch(strategyPda);
    expect(s.mxeVersion, "version should have moved").to.be.greaterThan(authorizedVersion);

    try {
      await program.methods.executeTrade(Buffer.alloc(0)).accountsPartial({
        executor: owner.publicKey, vaultConfig: vault, tradeIntent: intentPda,
        strategyState: strategyPda, vaultQuoteAta: ata(vault, QUOTE_MINT, true),
        vaultBaseAta: ata(vault, BASE_MINT, true), priceUpdate: PYTH_SOL_USD,
        jupiterProgram: JUPITER_PROGRAM,
      }).signers([owner]).rpc({ commitment: "confirmed" });
      expect.fail("executed an authorization bound to a replaced strategy");
    } catch (e) {
      expect(String(e)).to.match(/IntentStrategyMismatch|Unknown action/);
    }
  });
});

function readKeypair(path: string): any {
  return Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(path, "utf-8"))));
}
