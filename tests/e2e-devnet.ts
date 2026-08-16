/**
 * The whole user journey, once, against the live Arcium devnet cluster.
 *
 * Every other suite proves one property in isolation. This proves they compose:
 * a wallet that starts with nothing ends up with a funded vault, a private
 * strategy the cluster can evaluate, a real authorization produced by a
 * verified callback, and its money back at the end.
 *
 *   fresh wallet -> vault -> deposit -> encrypt -> convert -> evaluate
 *                -> bounded authorization -> withdraw everything
 *
 * The encryption path is the SDK the browser uses, not a test-local
 * reimplementation, so a break in the client crypto fails here too.
 *
 * What this cannot include is the swap. Devnet has no routable Jupiter
 * liquidity (RESEARCH §4.4), so `execute_trade` is covered on a mainnet fork
 * instead — by tests/swap-execution.ts and by the executor itself. Rather than
 * skip that step silently, this asserts the authorization is exactly what the
 * swap leg requires as its input, and says so.
 *
 * Requires a funded ANCHOR_WALLET that also holds the devnet test mint's
 * authority, because it provisions the fresh wallet it then acts as.
 */
import * as anchor from "@anchor-lang/core";
import web3Pkg from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import { expect } from "chai";
import {
  getArciumEnv, getCompDefAccOffset, getArciumProgram, getMXEPublicKey,
  getMXEAccAddress, getMempoolAccAddress, getCompDefAccAddress,
  getExecutingPoolAccAddress, getComputationAccAddress, getClusterAccAddress,
} from "@arcium-hq/client";
import {
  createMint as _unused, getOrCreateAssociatedTokenAccount, mintTo,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { encryptStrategy, nonceToU128 } from "@silentedge/sdk";
import { normalize } from "@silentedge/types";

const { PublicKey, Keypair, SystemProgram } = web3Pkg;

const BASE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const QUOTE_MINT = new PublicKey("36X5x8D8jc15XD971iSC9cAB5puaA7zXc6dggA96rxbw");
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

const DEPOSIT = 4_000_000_000n; // 4,000 test USDC
const SIZE_BPS = 1_000; // 10%

const LIMITS = {
  maxTradeBps: 1_000, maxSlippageBps: 100, dailyLossLimitBps: 500,
  cooldownSeconds: 0, maxOracleStalenessSec: 30, maxConfBps: 100,
  maxOracleDeviationBps: 200, sizeBps: SIZE_BPS,
};

describe("end to end, on devnet", function () {
  this.timeout(900_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as any;
  const arcium = getArciumProgram(provider);
  const conn = provider.connection;

  const payer = readKeypair(process.env.ANCHOR_WALLET!);
  /** A wallet that has never existed before this run. */
  const user = Keypair.generate();

  const pda = (seed: string, key: any) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), key.toBuffer()], program.programId)[0];
  const vault = pda("vault", user.publicKey);
  const strategyPda = pda("strategy", vault);
  const intentPda = pda("intent", vault);
  const ata = (o: any, m: any, off = false) => getAssociatedTokenAddressSync(m, o, off);

  let env: any;
  let mxeKey: Uint8Array;

  const send = async (builder: any, signer: any, label: string) => {
    const tx = await builder.transaction();
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(signer);
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      const why = (sim.value.logs ?? []).filter((l: string) => /Error|failed/.test(l)).slice(-3);
      throw new Error(`${label}: ${JSON.stringify(sim.value.err)} :: ${why.join(" | ")}`);
    }
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  };

  /** Poll for the on-chain effect; the callback lands after the queueing tx. */
  const settle = async (label: string, done: () => Promise<boolean>) => {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (await done().catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`${label}: no on-chain effect in time`);
  };

  before(async function () {
    try {
      env = getArciumEnv();
      await arcium.account.mxeAccount.fetch(getMXEAccAddress(program.programId));
      mxeKey = await getMXEPublicKey(provider, program.programId);
    } catch (e) {
      console.log(`      no vault MXE reachable — skipping: ${e}`);
      this.skip();
      return;
    }

    // Provision the fresh wallet: rent and fees, plus the quote asset.
    const fund = new web3Pkg.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: user.publicKey,
        lamports: 120_000_000,
      })
    );
    await web3Pkg.sendAndConfirmTransaction(conn, fund, [payer], { commitment: "confirmed" });

    const userQuote = await getOrCreateAssociatedTokenAccount(
      conn, payer, QUOTE_MINT, user.publicKey
    );
    await mintTo(conn, payer, QUOTE_MINT, userQuote.address, payer, Number(DEPOSIT));
    console.log(`      provisioned ${user.publicKey.toBase58().slice(0, 8)}… with 4,000 test USDC`);
  });

  it("creates a vault nobody but the owner can withdraw from", async () => {
    await send(
      program.methods.initializeVault(LIMITS).accountsPartial({
        owner: user.publicKey, vaultConfig: vault,
        baseMint: BASE_MINT, quoteMint: QUOTE_MINT,
        vaultBaseAta: ata(vault, BASE_MINT, true),
        vaultQuoteAta: ata(vault, QUOTE_MINT, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      user, "initialize_vault"
    );
    const v = await program.account.vaultConfig.fetch(vault);
    expect(v.owner.toBase58()).to.equal(user.publicKey.toBase58());
    expect(v.limits.sizeBps).to.equal(SIZE_BPS);
    console.log(`      vault ${vault.toBase58().slice(0, 8)}…`);
  });

  it("takes a deposit", async () => {
    await send(
      program.methods.deposit(new BN(DEPOSIT.toString())).accountsPartial({
        owner: user.publicKey, vaultConfig: vault, mint: QUOTE_MINT,
        ownerAta: ata(user.publicKey, QUOTE_MINT),
        vaultAta: ata(vault, QUOTE_MINT, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      user, "deposit"
    );
    const bal = await conn.getTokenAccountBalance(ata(vault, QUOTE_MINT, true));
    expect(bal.value.amount).to.equal(DEPOSIT.toString());
  });

  /**
   * Encrypted with the SDK the browser uses. Three scalars: `size_bps` is
   * public vault config and deliberately not in here (THREAT_MODEL T-38).
   */
  it("stores a strategy the program cannot read", async () => {
    const price = await livePrice();
    // The editable shape the builder produces: rules, not raw scalars.
    const entryPrice = (Number(price) / 1e6 + 10).toFixed(6);
    const draft = {
      name: "e2e",
      rules: [{ kind: "entry" as const, value: entryPrice }],
      sizeBps: SIZE_BPS,
    };
    const normalized = normalize(draft, 10_000);
    const encrypted = encryptStrategy(normalized, mxeKey);
    expect(encrypted.ciphertexts).to.have.length(3);

    await send(
      program.methods.submitStrategy(
        encrypted.ciphertexts.map((c: Uint8Array) => Array.from(c)),
        new BN(nonceToU128(encrypted.nonce).toString()),
        Array.from(encrypted.encryptionPublicKey)
      ).accountsPartial({
        owner: user.publicKey, vaultConfig: vault, strategyState: strategyPda,
        systemProgram: SystemProgram.programId,
      }),
      user, "submit_strategy"
    );

    // The plaintext thresholds must not be recoverable from the account.
    const raw = (await conn.getAccountInfo(strategyPda))!.data;
    const entry = Buffer.alloc(8);
    entry.writeBigUInt64LE(normalized.entryBelow);
    expect(raw.includes(entry), "a threshold appeared in the clear").to.equal(false);

    const s = await program.account.strategyState.fetch(strategyPda);
    expect(s.version).to.be.greaterThan(0);
    expect(s.mxeVersion, "not armed until converted").to.equal(0);
  });

  it("arms it by handing it to the cluster", async () => {
    const offset = new BN(web3Pkg.Keypair.generate().publicKey.toBytes().slice(0, 8));
    await send(
      program.methods.convertStrategy(offset).accountsPartial({
        payer: user.publicKey, vaultConfig: vault, strategyState: strategyPda,
        computationAccount: getComputationAccAddress(env.arciumClusterOffset, offset),
        clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(program.programId,
          Buffer.from(getCompDefAccOffset("store_strategy_v2")).readUInt32LE()),
      }),
      user, "convert_strategy"
    );
    await settle("convert", async () =>
      (await program.account.strategyState.fetch(strategyPda)).mxeVersion > 0
    );
    const s = await program.account.strategyState.fetch(strategyPda);
    console.log(`      armed, mxe_version ${s.mxeVersion}`);
  });

  it("produces a bounded authorization from a verified callback", async () => {
    await send(
      program.methods.initTradeIntent().accountsPartial({
        owner: user.publicKey, vaultConfig: vault, tradeIntent: intentPda,
        systemProgram: SystemProgram.programId,
      }),
      user, "init_trade_intent"
    );

    const startSlot = await conn.getSlot("confirmed");
    const offset = new BN(web3Pkg.Keypair.generate().publicKey.toBytes().slice(0, 8));
    await send(
      program.methods.evaluateStrategy(offset).accountsPartial({
        payer: user.publicKey, vaultConfig: vault, strategyState: strategyPda,
        tradeIntent: intentPda,
        vaultQuoteAta: ata(vault, QUOTE_MINT, true),
        vaultBaseAta: ata(vault, BASE_MINT, true),
        priceUpdate: PYTH_SOL_USD,
        computationAccount: getComputationAccAddress(env.arciumClusterOffset, offset),
        clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(program.programId,
          Buffer.from(getCompDefAccOffset("evaluate_strategy_v3")).readUInt32LE()),
      }),
      user, "evaluate_strategy"
    );

    await settle("evaluate", async () => {
      const sigs = await conn.getSignaturesForAddress(program.programId, { limit: 25 }, "confirmed");
      for (const s of sigs) {
        if ((s.slot ?? 0) < startSlot || s.err) continue;
        const tx = await conn.getTransaction(s.signature, {
          commitment: "confirmed", maxSupportedTransactionVersion: 0,
        });
        if (tx?.meta?.logMessages?.some((l) => l.includes("EvaluateStrategyV3Callback"))) return true;
      }
      return false;
    });

    const intent = await program.account.tradeIntent.fetch(intentPda);
    const v = await program.account.vaultConfig.fetch(vault);
    const s = await program.account.strategyState.fetch(strategyPda);

    expect(intent.side, "expected a BUY").to.equal(1);
    expect(intent.consumed).to.equal(false);
    // 10% of the deposit, sized from the public size_bps.
    expect(intent.amountIn.toString()).to.equal((DEPOSIT / 10n).toString());
    expect(intent.vaultNonce.toString()).to.equal(v.nonce.toString());
    expect(intent.strategyVersion).to.equal(s.mxeVersion);

    const slot = await conn.getSlot("confirmed");
    expect(Number(intent.expiresAtSlot)).to.be.greaterThan(slot);
    expect(Number(intent.expiresAtSlot) - slot).to.be.lessThanOrEqual(180);

    console.log(
      `      authorized BUY ${Number(intent.amountIn) / 1e6} USDC, ` +
      `expires in ${Number(intent.expiresAtSlot) - slot} slots`
    );
    console.log(
      "      (the swap that spends this runs on a mainnet fork — devnet has no " +
      "Jupiter liquidity; see tests/swap-execution.ts)"
    );
  });

  /**
   * The escape hatch, exercised last and for the full balance. Untouched by
   * everything above: no oracle, no cluster, no executor, and it works while a
   * live authorization is outstanding.
   */
  it("gives every deposited token back to the owner", async () => {
    const before = await conn.getTokenAccountBalance(ata(vault, QUOTE_MINT, true));
    await send(
      program.methods.withdraw(new BN(before.value.amount)).accountsPartial({
        owner: user.publicKey, vaultConfig: vault, mint: QUOTE_MINT,
        ownerAta: ata(user.publicKey, QUOTE_MINT),
        vaultAta: ata(vault, QUOTE_MINT, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      user, "withdraw"
    );
    const after = await conn.getTokenAccountBalance(ata(vault, QUOTE_MINT, true));
    const back = await conn.getTokenAccountBalance(ata(user.publicKey, QUOTE_MINT));
    expect(after.value.amount).to.equal("0");
    expect(back.value.amount).to.equal(DEPOSIT.toString());
    console.log(`      withdrew ${Number(before.value.amount) / 1e6} USDC, vault empty`);
  });

  async function livePrice(): Promise<bigint> {
    const d = (await conn.getAccountInfo(PYTH_SOL_USD))!.data;
    const off = 8 + 32 + 1 + 32;
    const raw = d.readBigInt64LE(off);
    const shift = d.readInt32LE(off + 16) + 6;
    return shift >= 0 ? raw * 10n ** BigInt(shift) : raw / 10n ** BigInt(-shift);
  }
});

function readKeypair(path: string): any {
  return Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(path, "utf-8"))));
}
