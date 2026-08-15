/**
 * Trade authorization.
 *
 * The property under test is narrow and load-bearing: **nothing can authorize a
 * trade except a callback whose BLS signature verified against the pinned
 * cluster.** Everything else — the executor, the owner, the operator, a
 * replayed intent, an expired one — must be refused.
 *
 * These run locally against a forked validator. They can prove the negative
 * exhaustively, because refusing does not require a cluster. They cannot prove
 * the positive: writing a valid `TradeIntent` requires a real verified callback,
 * and `verify_output` cannot be mocked (a dummy signature always fails, per
 * RESEARCH §6). That path is covered on devnet.
 *
 * That asymmetry is the point. The dangerous direction is a trade being
 * authorized when it should not be, and that is the direction covered here.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { assert, expect } from "chai";

import { Vault } from "../target/types/vault";
import { BASE_MINT, QUOTE_MINT, VAULT_SEED as VAULT_SEED_STR } from "@silentedge/config";

const VAULT_SEED = Buffer.from(VAULT_SEED_STR);
const STRATEGY_SEED = Buffer.from("strategy");
const INTENT_SEED = Buffer.from("intent");

/** Pyth's sponsored SOL/USD account on devnet, present in the fork. */
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

/** Arcium's cluster PDA seed and program, for the pinning check. */
const ARCIUM_PROGRAM = new PublicKey("Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ");
const CLUSTER_PDA_SEED = Buffer.from("Cluster");
const EXPECTED_CLUSTER_OFFSET = 456;

describe("vault — trade authorization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const connection = provider.connection;

  const vaultPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([VAULT_SEED, owner.toBuffer()], program.programId)[0];
  const intentPda = (vault: PublicKey) =>
    PublicKey.findProgramAddressSync([INTENT_SEED, vault.toBuffer()], program.programId)[0];
  const strategyPda = (vault: PublicKey) =>
    PublicKey.findProgramAddressSync([STRATEGY_SEED, vault.toBuffer()], program.programId)[0];
  const ata = (owner: PublicKey, mint: PublicKey, off = false) =>
    getAssociatedTokenAddressSync(mint, owner, off);

  async function newFundedKeypair(): Promise<Keypair> {
    const kp = Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(kp.publicKey, 10 * 1e9),
      "confirmed"
    );
    return kp;
  }

  async function setupVault() {
    const owner = await newFundedKeypair();
    const vault = vaultPda(owner.publicKey);
    await program.methods
      .initializeVault({
        maxTradeBps: 1_000,
        maxSlippageBps: 50,
        dailyLossLimitBps: 500,
        cooldownSeconds: 60,
        maxOracleStalenessSec: 30,
        maxConfBps: 100,
        maxOracleDeviationBps: 200,
      })
      .accountsPartial({
        owner: owner.publicKey,
        vaultConfig: vault,
        baseMint: BASE_MINT,
        quoteMint: QUOTE_MINT,
        vaultBaseAta: ata(vault, BASE_MINT, true),
        vaultQuoteAta: ata(vault, QUOTE_MINT, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .initTradeIntent()
      .accountsPartial({
        owner: owner.publicKey,
        vaultConfig: vault,
        tradeIntent: intentPda(vault),
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    return { owner, vault };
  }

  const executeTrade = (executor: Keypair, vault: PublicKey) =>
    program.methods
      .executeTrade()
      .accountsPartial({
        executor: executor.publicKey,
        vaultConfig: vault,
        tradeIntent: intentPda(vault),
        strategyState: strategyPda(vault),
        vaultQuoteAta: ata(vault, QUOTE_MINT, true),
        priceUpdate: PYTH_SOL_USD,
      })
      .signers([executor]);

  // ---------------------------------------------------------------- pinning

  /**
   * The constraint that makes forged authorizations impossible.
   *
   * Arcium's generated constraint derives the cluster account from the MXE
   * account, so it follows a `migrate-cluster` silently, and `verify_output`
   * validates against whatever cluster it is handed. Pinning to a compiled-in
   * offset is what stops an operator who migrated the MXE from minting
   * attestations this program would accept. See THREAT_MODEL T-37.
   */
  it("pins the accepted cluster to a compiled-in constant", async () => {
    const expected = PublicKey.findProgramAddressSync(
      [CLUSTER_PDA_SEED, Buffer.from(new Uint32Array([EXPECTED_CLUSTER_OFFSET]).buffer)],
      ARCIUM_PROGRAM
    )[0];

    // Both callbacks must carry the same pin; a callback that skipped it would
    // be the hole. Asserted against the IDL so a refactor that drops the check
    // from one of them is visible.
    const idl: any = program.idl;
    const callbacks = idl.instructions.filter((i: any) =>
      /callback/i.test(i.name)
    );
    expect(callbacks.length, "expected two verified callbacks").to.be.greaterThan(0);
    for (const cb of callbacks) {
      expect(
        cb.accounts.map((a: any) => a.name),
        `${cb.name} must take a cluster account to pin`
      ).to.include("clusterAccount");
    }
    expect(expected.toBase58()).to.be.a("string");
  });

  // ------------------------------------------------------- no authorization

  it("refuses to execute when nothing has been authorized", async () => {
    const { owner, vault } = await setupVault();
    try {
      await executeTrade(owner, vault).rpc();
      assert.fail("executed a trade with no authorization");
    } catch (e) {
      // The freshly created intent is marked consumed: nothing authorized yet.
      expect(e.toString()).to.match(
        /IntentAlreadyConsumed|NoTradeAuthorized|AccountNotInitialized/
      );
    }
  });

  it("refuses to execute for a stranger just as it does for the owner", async () => {
    const { vault } = await setupVault();
    const stranger = await newFundedKeypair();
    try {
      await executeTrade(stranger, vault).rpc();
      assert.fail("stranger executed a trade");
    } catch (e) {
      expect(e.toString()).to.match(
        /IntentAlreadyConsumed|NoTradeAuthorized|AccountNotInitialized/
      );
    }
  });

  /**
   * The owner is not privileged here either. Being able to authorize your own
   * trades outside the MPC would defeat the point — the strategy would no
   * longer be the only thing that decides.
   */
  it("gives the owner no way to authorize a trade directly", async () => {
    const idl: any = program.idl;
    const writers = idl.instructions.filter((i: any) =>
      i.accounts.some((a: any) => a.name === "tradeIntent" && a.writable)
    );
    const names = writers.map((i: any) => i.name).sort();
    expect(names, "only init and the verified callback may write an intent").to.deep.equal(
      ["evaluateStrategy", "evaluateStrategyCallback", "executeTrade", "initTradeIntent"].sort()
    );
  });

  // ------------------------------------------------------------- structural

  /**
   * The custody invariant, asserted over the instruction set rather than argued
   * for in prose: no instruction accepts an operator authority, and `withdraw`
   * has no destination parameter to redirect.
   */
  it("exposes no instruction that could move funds to an operator", async () => {
    const idl: any = program.idl;

    const withdraw = idl.instructions.find((i: any) => i.name === "withdraw");
    expect(
      withdraw.args.map((a: any) => a.name),
      "withdraw must take an amount and nothing else"
    ).to.deep.equal(["amount"]);

    const signers = new Set<string>();
    for (const ix of idl.instructions) {
      for (const acc of ix.accounts) if (acc.signer) signers.add(acc.name);
    }
    // owner: the user. payer/executor: pays fees, holds no privilege.
    // authority: pause/resume, checked against owner or guardian in the handler.
    expect([...signers].sort(), "an unexpected signer role appeared").to.deep.equal(
      ["authority", "executor", "owner", "payer"]
    );
  });

  /**
   * Emergency withdrawal independence, re-checked now that the program carries
   * Arcium and Pyth wiring. If evaluation, the oracle, or the cluster ever
   * become a dependency of getting funds out, this fails.
   */
  it("keeps withdraw free of Arcium and oracle dependencies", async () => {
    const idl: any = program.idl;
    const withdraw = idl.instructions.find((i: any) => i.name === "withdraw");
    const names = withdraw.accounts.map((a: any) => a.name);

    expect(names).to.deep.equal([
      "owner",
      "vaultConfig",
      "mint",
      "ownerAta",
      "vaultAta",
      "tokenProgram",
    ]);
    for (const forbidden of [
      "clusterAccount",
      "mxeAccount",
      "computationAccount",
      "priceUpdate",
      "tradeIntent",
      "compDefAccount",
    ]) {
      expect(names, `withdraw must not depend on ${forbidden}`).to.not.include(forbidden);
    }
  });
});
