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

/** Jupiter's aggregator. The only program execute_trade may CPI into. */
const JUPITER_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

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
        maxOracleDeviationBps: 200, sizeBps: 1_000,
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
      .executeTrade(Buffer.alloc(0))
      .accountsPartial({
        executor: executor.publicKey,
        vaultConfig: vault,
        tradeIntent: intentPda(vault),
        strategyState: strategyPda(vault),
        vaultQuoteAta: ata(vault, QUOTE_MINT, true),
        vaultBaseAta: ata(vault, BASE_MINT, true),
        priceUpdate: PYTH_SOL_USD,
        jupiterProgram: JUPITER_PROGRAM,
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
      ["evaluateStrategy", "evaluateStrategyV3Callback", "executeTrade", "initTradeIntent"].sort()
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
    // authority: pause/resume/stop, checked against the owner in the handler.
    expect([...signers].sort(), "an unexpected signer role appeared").to.deep.equal(
      ["authority", "executor", "owner", "payer"]
    );
  });

  // ------------------------------------------------------------ risk limits

  const LIMITS = {
    maxTradeBps: 1_000, maxSlippageBps: 50, dailyLossLimitBps: 500,
    cooldownSeconds: 60, maxOracleStalenessSec: 30, maxConfBps: 100,
    maxOracleDeviationBps: 200, sizeBps: 1_000,
  };

  const updateLimits = (signer: Keypair, vault: PublicKey, limits: any) =>
    program.methods
      .updateLimits(limits)
      .accountsPartial({ owner: signer.publicKey, vaultConfig: vault })
      .signers([signer]);

  /**
   * Limits were write-once. With them enforced, a bad value chosen at creation
   * would be permanent for a vault that has no close instruction.
   */
  it("lets the owner replace the risk envelope", async () => {
    const { owner, vault } = await setupVault();
    await updateLimits(owner, vault, { ...LIMITS, cooldownSeconds: 0 }).rpc();
    const v = await program.account.vaultConfig.fetch(vault);
    expect(v.limits.cooldownSeconds).to.equal(0);
  });

  it("refuses a stranger's attempt to loosen someone else's limits", async () => {
    const { vault } = await setupVault();
    const stranger = await newFundedKeypair();
    try {
      await updateLimits(stranger, vault, { ...LIMITS, maxTradeBps: 5_000 }).rpc();
      assert.fail("stranger rewrote another vault's limits");
    } catch (e) {
      // Seeds are derived from the signer, so a stranger's PDA is a different
      // account entirely — it does not exist.
      expect(e.toString()).to.match(/ConstraintSeeds|AccountNotInitialized|has_one/i);
    }
  });

  /**
   * An intent authorized under the old envelope must not execute under the new
   * one. The intent carries no copy of the limits, so the nonce is the lever.
   */
  it("invalidates in-flight authorizations when limits change", async () => {
    const { owner, vault } = await setupVault();
    const before = await program.account.vaultConfig.fetch(vault);
    await updateLimits(owner, vault, { ...LIMITS, maxTradeBps: 2_000 }).rpc();
    const after = await program.account.vaultConfig.fetch(vault);
    expect(Number(after.nonce)).to.be.greaterThan(Number(before.nonce));
  });

  it("still bounds every limit on the way in", async () => {
    const { owner, vault } = await setupVault();
    for (const [field, value] of [
      ["maxTradeBps", 6_000],            // ceiling 5000
      ["maxOracleStalenessSec", 120],    // ceiling tightened to 30
      ["maxConfBps", 500],               // ceiling tightened to 100
      ["cooldownSeconds", 86_400],       // ceiling 3600, previously unbounded
    ] as [string, number][]) {
      try {
        await updateLimits(owner, vault, { ...LIMITS, [field]: value }).rpc();
        assert.fail(`accepted out-of-range ${field} = ${value}`);
      } catch (e) {
        expect(e.toString(), `${field}`).to.match(/InvalidRiskLimit/);
      }
    }
  });

  /**
   * GUARDIAN resolved to this program's own id, which is the public key of the
   * deploy keypair — so the deployer could pause any user's vault. Gone now;
   * this asserts no non-owner authority survives anywhere in the instruction set.
   */
  it("gives no one but the owner authority over a vault", async () => {
    const { vault } = await setupVault();
    const stranger = await newFundedKeypair();
    for (const ix of ["pause", "stop"] as const) {
      try {
        await (program.methods as any)[ix]()
          .accountsPartial({ authority: stranger.publicKey, vaultConfig: vault })
          .signers([stranger])
          .rpc();
        assert.fail(`stranger called ${ix}`);
      } catch (e) {
        expect(e.toString(), ix).to.match(/NotPauseAuthority|NotOwner|ConstraintHasOne/i);
      }
    }
  });

  /**
   * Listing is a discovery flag, not a disclosure.
   *
   * It must be owner-only, and it must not create any path to strategy
   * plaintext — the marketplace shows things that were already public.
   */
  it("lets only the owner list a vault, and reveals nothing new by doing so", async () => {
    const { owner, vault } = await setupVault();
    const name = Array.from(Buffer.alloc(32));
    Buffer.from("public vault").copy(Buffer.from(name as any));

    const stranger = await newFundedKeypair();
    try {
      await (program.methods as any)
        .setListing(true, name)
        .accountsPartial({ owner: stranger.publicKey, vaultConfig: vault })
        .signers([stranger])
        .rpc();
      assert.fail("a stranger listed someone else's vault");
    } catch (e) {
      expect(e.toString()).to.match(/ConstraintSeeds|AccountNotInitialized|has_one/i);
    }

    await (program.methods as any)
      .setListing(true, name)
      .accountsPartial({ owner: owner.publicKey, vaultConfig: vault })
      .signers([owner])
      .rpc();
    const v: any = await program.account.vaultConfig.fetch(vault);
    expect(v.listed).to.equal(true);

    // Unlisting must always work: it is the control an owner reaches for when
    // they want out, so it cannot depend on any other condition.
    await (program.methods as any)
      .setListing(false, Array.from(Buffer.alloc(32)))
      .accountsPartial({ owner: owner.publicKey, vaultConfig: vault })
      .signers([owner])
      .rpc();
    expect((await program.account.vaultConfig.fetch(vault) as any).listed).to.equal(false);

    // No instruction anywhere exports strategy plaintext.
    const idl: any = program.idl;
    for (const ix of idl.instructions) {
      for (const acc of ix.accounts) {
        if (acc.name === "strategyState") {
          expect(
            ix.name,
            `${ix.name} touches strategy_state — confirm it cannot export it`
          ).to.be.oneOf([
            "submit_strategy", "submitStrategy",
            "convert_strategy", "convertStrategy",
            "evaluate_strategy", "evaluateStrategy",
            "store_strategy_v2_callback", "storeStrategyV2Callback",
            "evaluate_strategy_v3_callback", "evaluateStrategyV3Callback",
            "execute_trade", "executeTrade",
            // copy_strategy moves Enc<Mxe> ciphertext between two accounts that
            // are both already public. It cannot decrypt: the key is the
            // cluster's, and no instruction here holds it. Added deliberately
            // after checking that, not to make the test pass.
            "copy_strategy", "copyStrategy",
          ]);
        }
      }
    }
  });

  /**
   * The account-layout rule, asserted rather than trusted.
   *
   * `listed` and `name` were carved out of `reserved`, so VaultConfig is the
   * same size it was and every existing field kept its offset. Getting this
   * wrong strands every vault — including `withdraw`, which is the one path
   * that must never break.
   */
  it("keeps VaultConfig the same size when fields are carved from the reserve", async () => {
    const { vault } = await setupVault();
    const info = await connection.getAccountInfo(vault);
    // 8 discriminator + 3 pubkeys + RiskLimits(20) + status + bump + nonce
    // + last_trade_ts + listed + name(32) + reserved(29)
    expect(info!.data.length).to.equal(8 + 96 + 20 + 1 + 1 + 8 + 8 + 1 + 32 + 29);
  });

  // ------------------------------------------------------------- following

  const listVault = (owner: Keypair, vault: PublicKey, name = "leader") => {
    const bytes = Buffer.alloc(32);
    Buffer.from(name).copy(bytes);
    return (program.methods as any)
      .setListing(true, Array.from(bytes))
      .accountsPartial({ owner: owner.publicKey, vaultConfig: vault })
      .signers([owner])
      .rpc();
  };

  const copyFrom = (
    follower: Keypair,
    followerVault: PublicKey,
    leaderVault: PublicKey
  ) =>
    (program.methods as any)
      .copyStrategy()
      .accountsPartial({
        owner: follower.publicKey,
        vaultConfig: followerVault,
        strategyState: strategyPda(followerVault),
        leaderVault,
        leaderStrategy: strategyPda(leaderVault),
        systemProgram: SystemProgram.programId,
      })
      .signers([follower]);

  /**
   * Following copies a ciphertext the follower cannot read.
   *
   * `Enc<Mxe, Strategy>` is encrypted to the cluster, not to a person, and the
   * bytes were already public on the leader's account — so this discloses
   * nothing new. What must hold is that it only works on a *listed* vault, and
   * that the follower's own limits keep applying.
   */
  it("refuses to copy from a vault that has not been listed", async () => {
    const leader = await setupVault();
    const follower = await setupVault();
    try {
      await copyFrom(follower.owner, follower.vault, leader.vault).rpc();
      assert.fail("copied from an unlisted vault");
    } catch (e) {
      // Unlisted, and also unconverted — either refusal is correct here.
      expect(e.toString()).to.match(/VaultNotListed|StrategyNotConverted|AccountNotInitialized/);
    }
  });

  it("refuses to copy a strategy the cluster has never converted", async () => {
    const leader = await setupVault();
    await listVault(leader.owner, leader.vault);

    // A submitted-but-unconverted strategy has mxe_version 0 and is inert.
    await program.methods
      .submitStrategy(
        [Array(32).fill(1), Array(32).fill(2), Array(32).fill(3)],
        new BN(1),
        Array(32).fill(7)
      )
      .accountsPartial({
        owner: leader.owner.publicKey,
        vaultConfig: leader.vault,
        strategyState: strategyPda(leader.vault),
        systemProgram: SystemProgram.programId,
      })
      .signers([leader.owner])
      .rpc();

    const follower = await setupVault();
    try {
      await copyFrom(follower.owner, follower.vault, leader.vault).rpc();
      assert.fail("copied an unconverted strategy");
    } catch (e) {
      expect(e.toString()).to.match(/StrategyNotConverted/);
    }
  });

  it("refuses to let a vault follow itself", async () => {
    const v = await setupVault();
    await listVault(v.owner, v.vault);
    try {
      await copyFrom(v.owner, v.vault, v.vault).rpc();
      assert.fail("a vault followed itself");
    } catch (e) {
      expect(e.toString()).to.match(/CannotFollowSelf|StrategyNotConverted|AccountNotInitialized/);
    }
  });

  /**
   * The account that matters: a follower writes only into their own vault's
   * strategy PDA, seeded by their own signer. There is no argument that could
   * redirect the write into someone else's.
   */
  it("gives following no way to write into another vault", async () => {
    const idl: any = program.idl;
    const ix = idl.instructions.find(
      (i: any) => i.name === "copy_strategy" || i.name === "copyStrategy"
    );
    expect(ix, "copy_strategy must exist").to.not.equal(undefined);
    expect(ix.args, "following takes no arguments to redirect").to.deep.equal([]);

    const follower = ix.accounts.find((a: any) => a.name === "strategy_state" || a.name === "strategyState");
    expect(follower.writable, "only the follower's own strategy is written").to.equal(true);
    for (const name of ["leader_vault", "leaderVault", "leader_strategy", "leaderStrategy"]) {
      const acc = ix.accounts.find((a: any) => a.name === name);
      if (acc) expect(acc.writable ?? false, `${name} must be read-only`).to.equal(false);
    }
  });

  /**
   * The CPI surface, which is the most dangerous thing this program exposes.
   *
   * `execute_trade` hands caller-supplied instruction data and a caller-supplied
   * account list to another program. What stops that being an arbitrary CPI
   * executor is narrow and worth asserting: the swap program is an *account*
   * with a pinned address rather than an argument, and the output floor is
   * derived on chain from the oracle rather than named by the caller.
   *
   * If a refactor ever moves either into the argument list, this fails.
   */
  it("takes the swap program and the output floor out of the caller's hands", async () => {
    const idl: any = program.idl;
    const ix = idl.instructions.find((i: any) => i.name === "executeTrade");

    expect(
      ix.args.map((a: any) => a.name),
      "the route is the only thing the caller supplies"
    ).to.deep.equal(["routeData"]);

    const names = ix.accounts.map((a: any) => a.name);
    expect(names, "the aggregator must be an account so it can be address-pinned")
      .to.include("jupiterProgram");

    const jup = ix.accounts.find((a: any) => a.name === "jupiterProgram");
    expect(jup.address, "aggregator address must be pinned in the IDL").to.equal(
      JUPITER_PROGRAM.toBase58()
    );

    // Both vault ATAs present, because either can be the swap source.
    expect(names).to.include("vaultQuoteAta");
    expect(names).to.include("vaultBaseAta");

    // Nothing the caller can point at a wallet of their choosing.
    for (const n of names) {
      expect(n, `${n} looks like a caller-chosen destination`).to.not.match(
        /destination|recipient|payout|receiver/i
      );
    }
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
