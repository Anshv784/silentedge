/**
 * The swap leg, against forked mainnet state and a live Jupiter route.
 *
 * Phase 11 proved a verified callback can authorize a trade. This proves the
 * authorization can be *spent* — and, more to the point, that it cannot be
 * spent for anything other than what it authorized.
 *
 * Why a mainnet fork and not devnet: Jupiter is deployed on devnet at the same
 * address but has no routable liquidity, so `/build` returns no route for any
 * realistic pair (RESEARCH §4.4). The swap can only be exercised against real
 * pool state.
 *
 * Why the intent is seeded rather than produced: Arcium's MXE lives on devnet
 * cluster 456, which a mainnet fork does not have, and `verify_output` cannot
 * be mocked. Adding a test-only instruction that writes a `TradeIntent` would
 * put a forged-authorization path into the shipped program, so instead the
 * account is written directly with a surfpool cheatcode. Nothing test-only
 * enters the program.
 *
 * Requires: a surfpool fork of MAINNET, and the program built with
 * `--features mainnet` so `QUOTE_MINT` is real USDC. Skips otherwise.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction, AccountMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { expect, config as chaiConfig } from "chai";

// Show the whole program error; the default 40-char truncation hides the
// AnchorError name, which is the only part that distinguishes a real failure
// from a test-sequencing one.
chaiConfig.truncateThreshold = 0;

import { Vault } from "../target/types/vault";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
/** Pyth SOL/USD, mainnet. */
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

const VAULT_SEED = Buffer.from("vault");
const INTENT_SEED = Buffer.from("intent");
const STRATEGY_SEED = Buffer.from("strategy");

const SIDE_BUY = 1;
const SIDE_SELL = 2;
const DEPOSIT = 5_000_000_000n; // 5,000 USDC
const TRADE_IN = 500_000_000n; //   500 USDC, 10% — at the vault's cap

describe("vault — swap execution against forked mainnet", function () {
  this.timeout(300_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const connection = provider.connection;
  const owner = (provider.wallet as anchor.Wallet).payer;

  const vault = PublicKey.findProgramAddressSync(
    [VAULT_SEED, owner.publicKey.toBuffer()], program.programId)[0];
  const intentPda = PublicKey.findProgramAddressSync(
    [INTENT_SEED, vault.toBuffer()], program.programId)[0];
  const strategyPda = PublicKey.findProgramAddressSync(
    [STRATEGY_SEED, vault.toBuffer()], program.programId)[0];

  const ata = (o: PublicKey, m: PublicKey, off = false) =>
    getAssociatedTokenAddressSync(m, o, off);
  const vaultQuote = ata(vault, USDC, true);
  const vaultBase = ata(vault, WSOL, true);

  /**
   * `_rpcRequest` resolves with `{ error }` rather than throwing, so a cheatcode
   * that silently failed would leave the account untouched and every assertion
   * below would be made against state nobody wrote. Surface it.
   */
  const rpc = async (method: string, params: any[]) => {
    const res = await (connection as any)._rpcRequest(method, params);
    if (res?.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`);
    return res;
  };

  /** Write a token balance directly. Creates the ATA if absent. */
  const setToken = (o: PublicKey, mint: PublicKey, amount: bigint) =>
    rpc("surfnet_setTokenAccount", [
      o.toBase58(), mint.toBase58(), { amount: Number(amount) },
    ]);

  before(async function () {
    // A mainnet fork has a real USDC mint and an executable Jupiter.
    const [usdc, jup] = await Promise.all([
      connection.getAccountInfo(USDC).catch(() => null),
      connection.getAccountInfo(JUPITER).catch(() => null),
    ]);
    if (!usdc || !jup?.executable) {
      console.log("      not a mainnet fork — skipping");
      this.skip();
      return;
    }

    if (!(await connection.getAccountInfo(vault))) {
      await program.methods
        .initializeVault({
          maxTradeBps: 1_000, maxSlippageBps: 100, dailyLossLimitBps: 500,
          cooldownSeconds: 0, maxOracleStalenessSec: 30, maxConfBps: 100,
          maxOracleDeviationBps: 200,
        })
        .accountsPartial({
          owner: owner.publicKey, vaultConfig: vault,
          baseMint: WSOL, quoteMint: USDC,
          vaultBaseAta: vaultBase, vaultQuoteAta: vaultQuote,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: new PublicKey(
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    }

    // A strategy account must exist for execute_trade to compare versions
    // against. Its mxe_version stays 0 here; the seeded intent matches that.
    if (!(await connection.getAccountInfo(strategyPda))) {
      await program.methods
        .submitStrategy(
          [Array(32).fill(1), Array(32).fill(2), Array(32).fill(3), Array(32).fill(4)],
          new BN(1), Array(32).fill(7))
        .accountsPartial({
          owner: owner.publicKey, vaultConfig: vault, strategyState: strategyPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    }

    if (!(await connection.getAccountInfo(intentPda))) {
      await program.methods.initTradeIntent().accountsPartial({
        owner: owner.publicKey, vaultConfig: vault, tradeIntent: intentPda,
        systemProgram: SystemProgram.programId,
      }).signers([owner]).rpc();
    }

    await setToken(vault, USDC, DEPOSIT);
    await setToken(vault, WSOL, 0n); // destination must exist to receive
    await refreshOracle();

    // The fork outlives a single run, so the vault carries whatever the last
    // run left behind. A run that died mid-cooldown-test would otherwise leave
    // a 3600s cooldown set and every later run would fail on that instead of
    // its own assertion. Normalise rather than assume a clean vault.
    await setCooldown(0);
  });

  // Each test starts from a known cooldown. Without this a failure inside the
  // cooldown test leaks a 3600s setting into every test after it, which then
  // fails on CooldownActive instead of its own assertion.
  beforeEach(async function () {
    if (!(await connection.getAccountInfo(vault))) return; // suite skipped
    // Only when it differs. Two identical setCooldown(0) transactions in a row
    // serialize to the same bytes and the second is rejected as already
    // processed — a duplicate-signature failure that looks like a program bug.
    const v = await program.account.vaultConfig.fetch(vault);
    if (v.limits.cooldownSeconds !== 0) await setCooldown(0);
  });

  /**
   * Move the forked Pyth update's publish time up to the fork's clock.
   *
   * A fork copies the price account once and then runs its own clock, so within
   * 30 seconds the real `MAX_PRICE_AGE_SECONDS` check starts failing on a price
   * that is authentic but stale-by-simulation. Only the two timestamps are
   * touched — price, confidence and exponent stay exactly as mainnet published
   * them, so the staleness guard is still doing its job on real data rather
   * than being switched off for the test.
   */
  async function refreshOracle() {
    const acc = (await connection.getAccountInfo(PYTH_SOL_USD))!;
    const d = Buffer.from(acc.data);
    const clock = (await connection.getAccountInfo(
      new PublicKey("SysvarC1ock11111111111111111111111111111111")))!;
    const now = clock.data.readBigInt64LE(32);

    // disc(8) + write_authority(32) + verification_level(1) + feed_id(32)
    // + price(8) + conf(8) + exponent(4) = 93
    const PUBLISH_TIME = 93;
    d.writeBigInt64LE(now, PUBLISH_TIME);
    d.writeBigInt64LE(now, PUBLISH_TIME + 8); // prev_publish_time

    await rpc("surfnet_setAccount", [
      PYTH_SOL_USD.toBase58(),
      { data: d.toString("hex"), owner: acc.owner.toBase58(),
        lamports: acc.lamports, executable: false },
    ]);
  }

  /**
   * Overwrite the intent in place, preserving the discriminator and bump the
   * program itself wrote. Only the authorization fields are forged, which is
   * exactly the part a real callback would have filled in.
   */
  async function seedIntent(fields: {
    side?: number; amountIn?: bigint; consumed?: boolean; expiresIn?: number;
  } = {}) {
    const existing = (await connection.getAccountInfo(intentPda))!;
    const d = Buffer.from(existing.data);
    const slot = await connection.getSlot("confirmed");
    const vc = await program.account.vaultConfig.fetch(vault);
    const ss = await program.account.strategyState.fetch(strategyPda);

    let o = 8;
    vault.toBuffer().copy(d, o); o += 32;
    d.writeUInt8(fields.side ?? SIDE_BUY, o); o += 1;
    d.writeBigUInt64LE(fields.amountIn ?? TRADE_IN, o); o += 8;
    d.writeBigUInt64LE(0n, o); o += 8; // min_amount_out: derived on chain
    d.writeBigUInt64LE(BigInt(slot + (fields.expiresIn ?? 150)), o); o += 8;
    d.writeBigUInt64LE(BigInt(vc.nonce.toString()), o); o += 8;
    d.writeUInt32LE(ss.mxeVersion, o); o += 4;
    d.writeBigUInt64LE(0n, o); o += 8; // oracle_price: set at execution
    d.writeUInt8(fields.consumed ? 1 : 0, o);

    // hex, not base64 — surfnet_setAccount rejects base64 outright.
    await rpc("surfnet_setAccount", [
      intentPda.toBase58(),
      { data: d.toString("hex"), owner: program.programId.toBase58(),
        lamports: existing.lamports, executable: false },
    ]);

    // The seed is the premise of every assertion here; prove it landed.
    const check = await program.account.tradeIntent.fetch(intentPda);
    expect(check.amountIn.toString(), "intent seed did not apply")
      .to.equal((fields.amountIn ?? TRADE_IN).toString());
  }

  /** A live Jupiter route, constrained so the CPI fits without ALTs. */
  async function route(amountIn: bigint, side: number = SIDE_BUY) {
    const [inMint, outMint] = side === SIDE_BUY ? [USDC, WSOL] : [WSOL, USDC];
    const url =
      `https://api.jup.ag/swap/v2/build?inputMint=${inMint.toBase58()}` +
      `&outputMint=${outMint.toBase58()}&amount=${amountIn}` +
      `&taker=${vault.toBase58()}&maxAccounts=24&onlyDirectRoutes=true` +
      // Pin the venue *for the test only*. Left unconstrained, Jupiter routes
      // through oracle-quoted venues (BisonFi, Quantum) whose own on-chain
      // checks reject forked pool state with 0xfaded — a property of the fork,
      // not of the vault. A plain constant-product AMM executes deterministically
      // against forked state. Production sends no `dexes` filter.
      `&dexes=Raydium` +
      // Keep the proceeds as wSOL in the vault's ATA. Unwrapping would close
      // the account and send native SOL, which the balance assertion — and the
      // custody model — would rightly reject.
      `&wrapAndUnwrapSol=false&slippageBps=100`;
    // The public endpoint rate-limits a test run that quotes several times in a
    // row. A 429 is not a verdict on the vault, so back off rather than fail.
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url);
      if (r.status === 429 && attempt < 4) {
        await new Promise((res) => setTimeout(res, 2_000 * (attempt + 1)));
        continue;
      }
      if (!r.ok) throw new Error(`jupiter /build ${r.status}: ${await r.text()}`);
      const j: any = await r.json();
      if (!j.swapInstruction) throw new Error(`no route: ${JSON.stringify(j).slice(0, 200)}`);
      return j.swapInstruction;
    }
  }

  const executeTx = (si: any, jupiterProgram = JUPITER) =>
    program.methods
      .executeTrade(Buffer.from(si.data, "base64"))
      .accountsPartial({
        executor: owner.publicKey, vaultConfig: vault, tradeIntent: intentPda,
        strategyState: strategyPda, vaultQuoteAta: vaultQuote,
        vaultBaseAta: vaultBase, priceUpdate: PYTH_SOL_USD,
        jupiterProgram,
      })
      .remainingAccounts(
        si.accounts.map((a: any): AccountMeta => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: false, // the vault PDA signs via invoke_signed, not here
          isWritable: a.isWritable,
        })))
      .transaction();

  /**
   * Send, or throw with the program's own logs.
   *
   * Anchor's `sendAndConfirm` reports these failures as `Unknown action
   * 'undefined'`, which says nothing about what the program rejected and makes
   * a negative test indistinguishable from a broken one. Simulating first gets
   * the real `AnchorError` line out.
   */
  async function execute(si: any, jupiterProgram = JUPITER) {
    const tx = await executeTx(si, jupiterProgram);
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(owner);

    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = (sim.value.logs || []).filter((l) => l.includes("Error") || l.includes("failed"));
      throw new Error(`${JSON.stringify(sim.value.err)} :: ${logs.join(" | ")}`);
    }
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  const bal = async (a: PublicKey) =>
    BigInt((await connection.getTokenAccountBalance(a)).value.amount);

  const setCooldown = (cooldownSeconds: number) =>
    program.methods
      .updateLimits({
        maxTradeBps: 1_000, maxSlippageBps: 100, dailyLossLimitBps: 500,
        cooldownSeconds, maxOracleStalenessSec: 30, maxConfBps: 100,
        maxOracleDeviationBps: 200,
      })
      .accountsPartial({ owner: owner.publicKey, vaultConfig: vault })
      .signers([owner])
      .rpc();

  it("swaps the authorized amount and keeps the proceeds in the vault", async () => {
    await seedIntent();
    await refreshOracle();
    const si = await route(TRADE_IN);
    console.log(`      route: ${si.accounts.length} accounts`);

    const qBefore = await bal(vaultQuote);
    const bBefore = await bal(vaultBase);

    await execute(si);

    const qAfter = await bal(vaultQuote);
    const bAfter = await bal(vaultBase);
    console.log(
      `      spent ${(Number(qBefore - qAfter) / 1e6).toFixed(2)} USDC ` +
      `-> ${(Number(bAfter - bBefore) / 1e9).toFixed(4)} SOL`);

    // Exactly the authorized amount, from the vault's own account.
    expect((qBefore - qAfter).toString()).to.equal(TRADE_IN.toString());
    // Proceeds landed here, not anywhere else.
    const received = bAfter - bBefore;
    expect(Number(received), "proceeds must land in the vault").to.be.greaterThan(0);

    const intent = await program.account.tradeIntent.fetch(intentPda);
    expect(intent.consumed, "intent must be spent").to.equal(true);

    // The floor was derived on chain, recorded, and actually cleared.
    const floor = BigInt(intent.minAmountOut.toString());
    expect(Number(floor), "floor must be recorded").to.be.greaterThan(0);
    expect(received >= floor, `received ${received} below floor ${floor}`).to.equal(true);
    expect(BigInt(intent.oraclePrice.toString()) > 0n, "oracle price recorded").to.equal(true);

    const vc = await program.account.vaultConfig.fetch(vault);
    expect(vc.nonce.toString(), "nonce must advance").to.not.equal("0");
  });

  /**
   * The stop-loss path, which never worked.
   *
   * The circuit returns the *entire* base balance on a stop, and `execute_trade`
   * capped amount_in at max_trade_bps of the source — a cap that can never
   * exceed 50%. So every stop-loss reverted with TradeTooLarge and the vault's
   * only downside control was dead. Exits are now uncapped; entries are not.
   */
  it("executes a full-position exit, which the size cap used to reject", async () => {
    const held = 2_000_000_000n; // 2 SOL
    await setToken(vault, WSOL, held);
    await refreshOracle();
    // side SELL, spending the whole base balance — far above max_trade_bps.
    await seedIntent({ side: SIDE_SELL, amountIn: held });

    const si = await route(held, SIDE_SELL);
    const qBefore = await bal(vaultQuote);
    await execute(si);

    const bAfter = await bal(vaultBase);
    const qAfter = await bal(vaultQuote);
    console.log(`      exited ${(Number(held) / 1e9).toFixed(2)} SOL ` +
      `-> ${(Number(qAfter - qBefore) / 1e6).toFixed(2)} USDC`);

    expect(bAfter.toString(), "whole position must be gone").to.equal("0");
    expect(qAfter > qBefore, "proceeds must land in the vault").to.equal(true);
  });

  /**
   * A cooldown must throttle entries without ever blocking the way out —
   * execute_trade is permissionless, so a symmetric cooldown would let anyone
   * burn the window on a benign trade and lock out a de-risking exit.
   */
  it("throttles entries on cooldown but never exits", async () => {
    await setToken(vault, USDC, DEPOSIT);
    await setToken(vault, WSOL, 0n);

    // Earlier tests already stamped last_trade_ts, so the first entry here has
    // to happen with the cooldown off; the point under test is the second one.
    // Half the cap. TRADE_IN is exactly max_trade_bps of DEPOSIT, and this test
    // is about the cooldown, not about the size boundary.
    const entry = TRADE_IN / 2n;
    await refreshOracle();
    await seedIntent({ amountIn: entry });
    await execute(await route(entry));

    await setCooldown(3_600);
    await refreshOracle();
    await seedIntent({ amountIn: entry });
    try {
      await execute(await route(entry));
      expect.fail("second entry ignored the cooldown");
    } catch (e) {
      expect(String(e)).to.match(/CooldownActive/);
    }

    // An exit inside the same window: allowed.
    const held = await bal(vaultBase);
    expect(Number(held), "need base to exit").to.be.greaterThan(0);
    await refreshOracle();
    await seedIntent({ side: SIDE_SELL, amountIn: held });
    await execute(await route(held, SIDE_SELL));
    expect((await bal(vaultBase)).toString(), "exit must clear").to.equal("0");

    // Leave the vault as we found it — a 3600s cooldown would otherwise make
    // every later test fail with CooldownActive instead of its own assertion.
    await setCooldown(0);
  });

  it("refuses to swap through anything but the pinned aggregator", async () => {
    await seedIntent();
    const si = await route(TRADE_IN);
    try {
      await execute(si, Keypair.generate().publicKey);
      expect.fail("swapped through an unpinned program");
    } catch (e) {
      expect(String(e)).to.match(/SwapProgramNotAllowed|ConstraintAddress/);
    }
  });

  /**
   * The intent authorizes an amount, not a budget. A route that moves more than
   * the intent named must revert even though the swap itself would succeed.
   */
  it("refuses a route that spends more than was authorized", async () => {
    await seedIntent({ amountIn: TRADE_IN / 2n });
    const si = await route(TRADE_IN); // route spends double the authorization
    try {
      await execute(si);
      expect.fail("spent more than the intent authorized");
    } catch (e) {
      expect(String(e)).to.match(/UnexpectedSourceDelta/);
    }
  });

  it("refuses to spend the same authorization twice", async () => {
    await seedIntent({ consumed: true });
    const si = await route(TRADE_IN);
    try {
      await execute(si);
      expect.fail("replayed a consumed intent");
    } catch (e) {
      expect(String(e)).to.match(/IntentAlreadyConsumed/);
    }
  });
});
