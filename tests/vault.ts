/**
 * Phase 2 custody tests.
 *
 * The negative tests matter more than the positive ones here. A vault that
 * accepts a deposit is unremarkable; a vault that refuses every unauthorized
 * path is the entire product. Test obligations: THREAT_MODEL.md §9.
 *
 * Runs against Surfpool forked from devnet, so BASE_MINT and QUOTE_MINT are the
 * real mints and the production allowlist is what gets exercised.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";

import { Vault } from "../target/types/vault";
// Imported rather than restated: if these ever drift from constants.rs, the
// tests and the web app drift together and the mismatch stays invisible.
import { BASE_MINT, QUOTE_MINT, VAULT_SEED as VAULT_SEED_STR } from "@silentedge/config";

const VAULT_SEED = Buffer.from(VAULT_SEED_STR);

const DECIMALS = 6;
const FUNDING = 1_000 * 10 ** DECIMALS;

const validLimits = () => ({
  maxTradeBps: 1_000,
  maxSlippageBps: 50,
  dailyLossLimitBps: 500,
  cooldownSeconds: 60,
  maxOracleStalenessSec: 30,
  maxConfBps: 100,
  maxOracleDeviationBps: 200,
});

describe("vault — custody", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const connection = provider.connection;

  const vaultPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([VAULT_SEED, owner.toBuffer()], program.programId)[0];

  const ata = (owner: PublicKey, mint: PublicKey, allowOwnerOffCurve = false) =>
    getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve);

  async function newFundedKeypair(): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await connection.requestAirdrop(kp.publicKey, 10 * 1e9);
    await connection.confirmTransaction(sig, "confirmed");
    return kp;
  }

  /**
   * Give `owner` a funded quote-token ATA.
   *
   * Circle holds the devnet USDC mint authority, so we cannot mint. Surfpool's
   * `surfnet_setTokenAccount` cheatcode writes the balance directly and creates
   * the ATA if needed — which also keeps the real mint in play, so the vault's
   * production allowlist is what gets exercised.
   */
  async function fundQuote(owner: Keypair, amount: number): Promise<PublicKey> {
    await (connection as any)._rpcRequest("surfnet_setTokenAccount", [
      owner.publicKey.toBase58(),
      QUOTE_MINT.toBase58(),
      { amount },
    ]);
    return ata(owner.publicKey, QUOTE_MINT);
  }

  async function initVault(owner: Keypair, limits = validLimits()) {
    const vault = vaultPda(owner.publicKey);
    return program.methods
      .initializeVault(limits)
      .accountsPartial({
        owner: owner.publicKey,
        vaultConfig: vault,
        baseMint: BASE_MINT,
        quoteMint: QUOTE_MINT,
        vaultBaseAta: ata(vault, BASE_MINT, true),
        vaultQuoteAta: ata(vault, QUOTE_MINT, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
  }

  async function setupVault(funding = FUNDING): Promise<{ owner: Keypair; vault: PublicKey }> {
    const owner = await newFundedKeypair();
    await initVault(owner);
    await fundQuote(owner, funding);
    return { owner, vault: vaultPda(owner.publicKey) };
  }

  const balance = async (address: PublicKey) =>
    Number((await getAccount(connection, address)).amount);

  // -------------------------------------------------------------- init

  it("initializes a vault and its two program-owned token accounts", async () => {
    const owner = await newFundedKeypair();
    await initVault(owner);

    const vault = vaultPda(owner.publicKey);
    const config = await program.account.vaultConfig.fetch(vault);
    expect(config.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(config.status).to.deep.equal({ active: {} });
    expect(await balance(ata(vault, BASE_MINT, true))).to.equal(0);
    expect(await balance(ata(vault, QUOTE_MINT, true))).to.equal(0);
  });

  it("rejects risk limits above the ceiling", async () => {
    const owner = await newFundedKeypair();
    // A single trade must never be allowed to drain the whole vault.
    const limits = { ...validLimits(), maxTradeBps: 9_000 };
    try {
      await initVault(owner, limits);
      assert.fail("expected InvalidRiskLimit");
    } catch (e) {
      expect(e.toString()).to.include("InvalidRiskLimit");
    }
  });

  it("rejects zero-valued risk limits", async () => {
    const owner = await newFundedKeypair();
    const limits = { ...validLimits(), maxSlippageBps: 0 };
    try {
      await initVault(owner, limits);
      assert.fail("expected InvalidRiskLimit");
    } catch (e) {
      expect(e.toString()).to.include("InvalidRiskLimit");
    }
  });

  it("cannot initialize the same vault twice", async () => {
    const owner = await newFundedKeypair();
    await initVault(owner);
    try {
      // Different limits, so this is a genuinely different transaction rather
      // than a replay of the first one -- otherwise the runtime rejects it as
      // "already processed" and the test would pass for the wrong reason.
      await initVault(owner, { ...validLimits(), cooldownSeconds: 61 });
      assert.fail("expected re-initialization to fail");
    } catch (e) {
      expect(e.toString()).to.match(/already in use|Allocate|AccountDiscriminatorAlreadySet/);
    }
  });

  // -------------------------------------------------------------- deposit

  const depositIx = (owner: Keypair, amount: number) => {
    const vault = vaultPda(owner.publicKey);
    return program.methods
      .deposit(new BN(amount))
      .accountsPartial({
        owner: owner.publicKey,
        vaultConfig: vault,
        mint: QUOTE_MINT,
        ownerAta: ata(owner.publicKey, QUOTE_MINT),
        vaultAta: ata(vault, QUOTE_MINT, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner]);
  };

  it("deposit moves tokens into the vault", async () => {
    const { owner, vault } = await setupVault();
    await depositIx(owner, 250).rpc();

    expect(await balance(ata(vault, QUOTE_MINT, true))).to.equal(250);
    expect(await balance(ata(owner.publicKey, QUOTE_MINT))).to.equal(FUNDING - 250);
  });

  it("deposit rejects zero amount", async () => {
    const { owner } = await setupVault();
    try {
      await depositIx(owner, 0).rpc();
      assert.fail("expected ZeroAmount");
    } catch (e) {
      expect(e.toString()).to.include("ZeroAmount");
    }
  });

  it("deposit is blocked while paused", async () => {
    const { owner } = await setupVault();
    await program.methods
      .pause()
      .accountsPartial({ authority: owner.publicKey, vaultConfig: vaultPda(owner.publicKey) })
      .signers([owner])
      .rpc();

    try {
      await depositIx(owner, 100).rpc();
      assert.fail("expected VaultNotActive");
    } catch (e) {
      expect(e.toString()).to.include("VaultNotActive");
    }
  });

  // -------------------------------------------------------------- withdraw

  const withdrawIx = (
    signer: Keypair,
    amount: number,
    overrides: Partial<{ vaultConfig: PublicKey; ownerAta: PublicKey; vaultAta: PublicKey }> = {}
  ) => {
    const vault = overrides.vaultConfig ?? vaultPda(signer.publicKey);
    return program.methods
      .withdraw(new BN(amount))
      .accountsPartial({
        owner: signer.publicKey,
        vaultConfig: vault,
        mint: QUOTE_MINT,
        ownerAta: overrides.ownerAta ?? ata(signer.publicKey, QUOTE_MINT),
        vaultAta: overrides.vaultAta ?? ata(vault, QUOTE_MINT, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer]);
  };

  it("withdraw returns tokens to the owner", async () => {
    const { owner, vault } = await setupVault();
    await depositIx(owner, 500).rpc();
    await withdrawIx(owner, 200).rpc();

    expect(await balance(ata(vault, QUOTE_MINT, true))).to.equal(300);
    expect(await balance(ata(owner.publicKey, QUOTE_MINT))).to.equal(FUNDING - 300);
  });

  /**
   * The single most important test in this file.
   *
   * Pausing is a circuit breaker for trading. If it could also block
   * withdrawals it would be a mechanism for trapping user funds, making the
   * vault custodial in practice regardless of what the docs claim. See T-4.
   */
  it("withdraw SUCCEEDS while paused", async () => {
    const { owner, vault } = await setupVault();
    await depositIx(owner, 500).rpc();

    await program.methods
      .pause()
      .accountsPartial({ authority: owner.publicKey, vaultConfig: vault })
      .signers([owner])
      .rpc();
    expect((await program.account.vaultConfig.fetch(vault)).status).to.deep.equal({
      paused: {},
    });

    await withdrawIx(owner, 500).rpc();
    expect(await balance(ata(vault, QUOTE_MINT, true))).to.equal(0);
  });

  /** `stop` is a wind-down, not a trap. */
  it("withdraw SUCCEEDS while stopped", async () => {
    const { owner, vault } = await setupVault();
    await depositIx(owner, 400).rpc();

    await program.methods
      .stop()
      .accountsPartial({ authority: owner.publicKey, vaultConfig: vault })
      .signers([owner])
      .rpc();

    await withdrawIx(owner, 400).rpc();
    expect(await balance(ata(vault, QUOTE_MINT, true))).to.equal(0);
  });

  it("withdraw rejects more than the balance", async () => {
    const { owner } = await setupVault();
    await depositIx(owner, 100).rpc();
    try {
      await withdrawIx(owner, 101).rpc();
      assert.fail("expected InsufficientBalance");
    } catch (e) {
      expect(e.toString()).to.include("InsufficientBalance");
    }
  });

  it("withdraw rejects zero amount", async () => {
    const { owner } = await setupVault();
    try {
      await withdrawIx(owner, 0).rpc();
      assert.fail("expected ZeroAmount");
    } catch (e) {
      expect(e.toString()).to.include("ZeroAmount");
    }
  });

  /** The config PDA is seeded by the signer, so this derivation cannot match. */
  it("attacker cannot withdraw from another user's vault", async () => {
    const { owner: victim, vault: victimVault } = await setupVault();
    await depositIx(victim, 500).rpc();

    const attacker = await newFundedKeypair();
    await fundQuote(attacker, 0);

    try {
      await withdrawIx(attacker, 500, { vaultConfig: victimVault }).rpc();
      assert.fail("attacker drained a vault they do not own");
    } catch (e) {
      // The PDA is seeded by the signer, so derivation fails before anything else.
      expect(e.toString()).to.include("ConstraintSeeds");
    }
    expect(await balance(ata(victimVault, QUOTE_MINT, true))).to.equal(500);
  });

  /**
   * Owner signs, but redirects the destination. This is the case a
   * `destination: Pubkey` parameter would have allowed, and the reason the
   * destination is derived from vault.owner instead.
   */
  it("withdraw rejects destination substitution", async () => {
    const { owner, vault } = await setupVault();
    await depositIx(owner, 500).rpc();

    const attacker = await newFundedKeypair();
    const attackerAta = await fundQuote(attacker, 0);

    try {
      await withdrawIx(owner, 500, { ownerAta: attackerAta }).rpc();
      assert.fail("funds were sent to a non-owner account");
    } catch (e) {
      expect(e.toString()).to.include("ConstraintTokenOwner");
    }
    expect(await balance(attackerAta)).to.equal(0);
  });

  /** Draining a different vault's token account while signing for your own. */
  it("withdraw rejects a foreign vault token account", async () => {
    const { owner: victim, vault: victimVault } = await setupVault();
    await depositIx(victim, 500).rpc();

    const { owner: attacker } = await setupVault(0);
    await fundQuote(attacker, 0);

    try {
      await withdrawIx(attacker, 500, {
        vaultAta: ata(victimVault, QUOTE_MINT, true),
      }).rpc();
      assert.fail("attacker drained a foreign vault token account");
    } catch (e) {
      expect(e.toString()).to.include("ConstraintTokenOwner");
    }
    expect(await balance(ata(victimVault, QUOTE_MINT, true))).to.equal(500);
  });

  // -------------------------------------------------------------- status

  it("owner can pause and resume", async () => {
    const { owner, vault } = await setupVault(0);
    const accounts = { authority: owner.publicKey, vaultConfig: vault };

    await program.methods.pause().accountsPartial(accounts).signers([owner]).rpc();
    expect((await program.account.vaultConfig.fetch(vault)).status).to.deep.equal({
      paused: {},
    });

    await program.methods.resume().accountsPartial(accounts).signers([owner]).rpc();
    expect((await program.account.vaultConfig.fetch(vault)).status).to.deep.equal({
      active: {},
    });
  });

  it("a stranger cannot change vault status", async () => {
    const { owner, vault } = await setupVault(0);
    const stranger = await newFundedKeypair();
    const accounts = { authority: stranger.publicKey, vaultConfig: vault };

    for (const method of ["pause", "resume", "stop"] as const) {
      try {
        await program.methods[method]().accountsPartial(accounts).signers([stranger]).rpc();
        assert.fail(`stranger changed status via ${method}`);
      } catch (e) {
        expect(e.toString()).to.include("NotPauseAuthority");
      }
    }
    void owner;
  });

  it("a stopped vault cannot be resumed", async () => {
    const { owner, vault } = await setupVault(0);
    const accounts = { authority: owner.publicKey, vaultConfig: vault };

    await program.methods.stop().accountsPartial(accounts).signers([owner]).rpc();
    try {
      await program.methods.resume().accountsPartial(accounts).signers([owner]).rpc();
      assert.fail("expected VaultStopped");
    } catch (e) {
      expect(e.toString()).to.include("VaultStopped");
    }
  });

  // -------------------------------------------------------------- structural

  /**
   * Emergency-withdrawal independence (THREAT_MODEL §8.1).
   *
   * A behavioural test cannot prove Arcium is absent, because Arcium is absent
   * from the whole program today. What this pins is the *shape* of `withdraw`:
   * if a future phase adds an account, this fails and forces a deliberate
   * decision rather than a silent new dependency.
   */
  /**
   * The web app reads `status` at a fixed byte offset instead of pulling Anchor
   * into the browser bundle. That offset is only correct as long as the fields
   * before it in VaultConfig keep their sizes, and nothing about changing
   * `state.rs` would otherwise fail. This pins it.
   */
  it("vault status sits at the byte offset the web app reads", async () => {
    const STATUS_OFFSET = 8 + 32 + 32 + 32 + 18; // discriminator + 3 pubkeys + RiskLimits
    const { owner, vault } = await setupVault(0);

    const active = await connection.getAccountInfo(vault);
    expect(active!.data[STATUS_OFFSET], "Active should encode as 0").to.equal(0);

    await program.methods
      .pause()
      .accountsPartial({ authority: owner.publicKey, vaultConfig: vault })
      .signers([owner])
      .rpc();
    const paused = await connection.getAccountInfo(vault);
    expect(paused!.data[STATUS_OFFSET], "Paused should encode as 1").to.equal(1);

    await program.methods
      .stop()
      .accountsPartial({ authority: owner.publicKey, vaultConfig: vault })
      .signers([owner])
      .rpc();
    const stopped = await connection.getAccountInfo(vault);
    expect(stopped!.data[STATUS_OFFSET], "Stopped should encode as 2").to.equal(2);
  });

  it("withdraw's account list stays minimal and dependency-free", async () => {
    const owner = Keypair.generate();
    const vault = vaultPda(owner.publicKey);
    const ix = await withdrawIx(owner, 1).instruction();

    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys, "withdraw gained an account — confirm it adds no external dependency").to.deep.equal([
      owner.publicKey.toBase58(),
      vault.toBase58(),
      QUOTE_MINT.toBase58(),
      ata(owner.publicKey, QUOTE_MINT).toBase58(),
      ata(vault, QUOTE_MINT, true).toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
  });
});
