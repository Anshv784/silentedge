/**
 * Phase 2 custody tests.
 *
 * The negative tests matter more than the positive ones here. A vault that
 * accepts a deposit is unremarkable; a vault that refuses every unauthorized
 * path is the entire product. Test obligations: SECURITY.md §9.
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
import { x25519 } from "@arcium-hq/client";
import { encryptStrategy, nonceToU128 } from "@silentedge/sdk";
import { normalize, type Strategy } from "@silentedge/types";

const VAULT_SEED = Buffer.from(VAULT_SEED_STR);
const STRATEGY_SEED = Buffer.from("strategy");

const DECIMALS = 6;
const FUNDING = 1_000 * 10 ** DECIMALS;

const validLimits = () => ({
  maxTradeBps: 1_000,
  maxSlippageBps: 50,
  dailyLossLimitBps: 500,
  cooldownSeconds: 60,
  maxOracleStalenessSec: 30,
  maxConfBps: 100,
  maxOracleDeviationBps: 200, sizeBps: 1_000,
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

  /**
   * SECURITY.md §9 listed "non-allowlisted mint -> rejected" as a met
   * obligation while `MintNotAllowed` appeared nowhere in tests/. The allowlist
   * is what keeps a vault's two sides to assets the oracle and the swap path
   * actually understand, so it is worth a detector rather than a claim.
   */
  it("refuses a vault built on a mint outside the allowlist", async () => {
    const owner = await newFundedKeypair();
    const vault = vaultPda(owner.publicKey);
    // A real mint, just not one this program will trade.
    const foreign = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    try {
      await program.methods
        .initializeVault(validLimits())
        .accountsPartial({
          owner: owner.publicKey,
          vaultConfig: vault,
          baseMint: BASE_MINT,
          quoteMint: foreign,
          vaultBaseAta: ata(vault, BASE_MINT, true),
          vaultQuoteAta: ata(vault, foreign, true),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      assert.fail("accepted a mint outside the allowlist");
    } catch (e) {
      expect(e.toString()).to.match(/MintNotAllowed|ConstraintRaw/);
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

  // -------------------------------------------------------------- strategy

  const SECRET_DRAFT: Strategy = {
    name: "Range trade",
    rules: [
      { kind: "entry", value: "150" },
      { kind: "exit", value: "180.5" },
      { kind: "stop", value: "120" },
    ],
    sizeBps: 1_000,
  };

  const strategyPda = (vault: PublicKey) =>
    PublicKey.findProgramAddressSync([STRATEGY_SEED, vault.toBuffer()], program.programId)[0];

  function encryptedDraft() {
    const mxePriv = x25519.utils.randomSecretKey();
    const normalized = normalize(SECRET_DRAFT, 1_000);
    const e = encryptStrategy(normalized, x25519.getPublicKey(mxePriv));
    return { normalized, e };
  }

  const submitIx = (owner: Keypair, e: ReturnType<typeof encryptedDraft>["e"]) =>
    program.methods
      .submitStrategy(
        Array.from(e.ciphertexts).map((c) => Array.from(c)) as never,
        new BN(nonceToU128(e.nonce).toString()),
        Array.from(e.encryptionPublicKey) as never
      )
      .accountsPartial({
        owner: owner.publicKey,
        vaultConfig: vaultPda(owner.publicKey),
        strategyState: strategyPda(vaultPda(owner.publicKey)),
        systemProgram: SystemProgram.programId,
      })
      .signers([owner]);

  it("stores an encrypted strategy", async () => {
    const { owner, vault } = await setupVault(0);
    const { e } = encryptedDraft();
    await submitIx(owner, e).rpc();

    const state = await program.account.strategyState.fetch(strategyPda(vault));
    expect(state.vault.toBase58()).to.equal(vault.toBase58());
    expect(state.version).to.equal(1);
    expect(Buffer.from(state.encryptionPubkey)).to.deep.equal(
      Buffer.from(e.encryptionPublicKey)
    );
    expect(state.ciphertexts).to.have.length(3); // three encrypted scalars; size_bps is public (T-38)
  });

  it("bumps the version when a strategy is replaced", async () => {
    const { owner, vault } = await setupVault(0);
    await submitIx(owner, encryptedDraft().e).rpc();
    await submitIx(owner, encryptedDraft().e).rpc();

    const state = await program.account.strategyState.fetch(strategyPda(vault));
    expect(state.version).to.equal(2);
  });

  it("rejects an all-zero encryption key", async () => {
    const { owner } = await setupVault(0);
    const { e } = encryptedDraft();
    try {
      await program.methods
        .submitStrategy(
          Array.from(e.ciphertexts).map((c) => Array.from(c)) as never,
          new BN(nonceToU128(e.nonce).toString()),
          Array.from(new Uint8Array(32)) as never
        )
        .accountsPartial({
          owner: owner.publicKey,
          vaultConfig: vaultPda(owner.publicKey),
          strategyState: strategyPda(vaultPda(owner.publicKey)),
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      assert.fail("expected InvalidEncryptionKey");
    } catch (e) {
      expect(e.toString()).to.include("InvalidEncryptionKey");
    }
  });

  it("stops a stranger submitting a strategy to someone else's vault", async () => {
    const { owner, vault } = await setupVault(0);
    await submitIx(owner, encryptedDraft().e).rpc();

    const attacker = await newFundedKeypair();
    const { e } = encryptedDraft();
    try {
      await program.methods
        .submitStrategy(
          Array.from(e.ciphertexts).map((c) => Array.from(c)) as never,
          new BN(nonceToU128(e.nonce).toString()),
          Array.from(e.encryptionPublicKey) as never
        )
        .accountsPartial({
          owner: attacker.publicKey,
          vaultConfig: vault, // victim's vault
          strategyState: strategyPda(vault),
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("stranger replaced another user's strategy");
    } catch (e) {
      expect(e.toString()).to.include("ConstraintSeeds");
    }
    const state = await program.account.strategyState.fetch(strategyPda(vault));
    expect(state.version, "victim's strategy was replaced").to.equal(1);
  });

  /**
   * The claim under test: submitting a strategy puts no plaintext on chain.
   *
   * Checks the actual bytes of the confirmed transaction and of the stored
   * account, rather than trusting that encryption happened upstream.
   */
  /**
   * Replacing a strategy must stop the previous one trading.
   *
   * `mxe_version` is what a trade authorization binds to, and what evaluation
   * requires to be non-zero — so before this was fixed, submitting a
   * replacement left the converted copy of the *old* strategy armed and
   * trading, and an owner submitting a deliberately inert strategy to stop
   * their bot would have been silently ignored. The doc comment on
   * `StrategyState::version` asserted the opposite of what the code did.
   *
   * The MXE fields are seeded directly rather than by running a conversion,
   * because a conversion needs the cluster and this is a local test. That is
   * sound here: the point under test is what `submit_strategy` does to those
   * bytes, not how they came to be set.
   */
  it("retires the converted strategy when a replacement is submitted", async () => {
    const { owner } = await setupVault(0);
    const strategyAcc = strategyPda(vaultPda(owner.publicKey));
    await submitIx(owner, encryptedDraft().e).rpc();

    // disc 8 + vault 32 + ciphertexts 96 + nonce 16 + enc_pubkey 32
    // + version 4 + bump 1 + follows 32 + reserved 0 = 221
    const MXE_CIPHERTEXTS = 221;
    const MXE_NONCE = 317;
    const MXE_VERSION = 333;

    const acc = (await connection.getAccountInfo(strategyAcc))!;
    const armed = Buffer.from(acc.data);
    armed.fill(0xab, MXE_CIPHERTEXTS, MXE_NONCE); // a converted strategy
    armed.writeUInt32LE(7, MXE_VERSION);
    const res = await (connection as any)._rpcRequest("surfnet_setAccount", [
      strategyAcc.toBase58(),
      { data: armed.toString("hex"), owner: acc.owner.toBase58(),
        lamports: acc.lamports, executable: false },
    ]);
    expect(res.error, `cheatcode failed: ${JSON.stringify(res.error)}`).to.be.undefined;

    const seeded = await program.account.strategyState.fetch(strategyAcc);
    expect(seeded.mxeVersion, "fixture must actually arm the strategy").to.equal(7);

    await submitIx(owner, encryptedDraft().e).rpc();

    const after = await program.account.strategyState.fetch(strategyAcc);
    expect(after.mxeVersion, "replacing a strategy must disarm the old one").to.equal(0);
    expect(
      Buffer.from((after.mxeCiphertexts as number[][]).flat()).every((b) => b === 0),
      "the old converted ciphertext must not survive a replacement"
    ).to.be.true;
    expect(after.mxeNonce.toString()).to.equal("0");

    // And the plaintext submission did land, so this is a retirement rather
    // than the instruction having failed.
    expect(after.version, "the submission itself must still have applied")
      .to.be.greaterThan(0);
  });

  it("puts no plaintext strategy value on chain", async () => {
    const { owner, vault } = await setupVault(0);
    const { normalized, e } = encryptedDraft();
    const signature = await submitIx(owner, e).rpc();

    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const account = await connection.getAccountInfo(strategyPda(vault));

    const haystacks: [string, Buffer][] = [
      ["transaction", Buffer.from(JSON.stringify(tx))],
      ["account data", account!.data],
      ["logs", Buffer.from((tx!.meta?.logMessages ?? []).join("\n"))],
    ];

    const secrets = [
      normalized.entryBelow,
      normalized.exitAbove,
      normalized.stopBelow,
    ];

    for (const [where, hay] of haystacks) {
      for (const secret of secrets) {
        // Decimal form, as it would appear in any log or JSON field.
        expect(hay.includes(Buffer.from(secret.toString())), `${secret} as text in ${where}`)
          .to.equal(false);

        // Little-endian u64, as it would appear if written raw.
        const le = Buffer.alloc(8);
        le.writeBigUInt64LE(secret);
        expect(hay.includes(le), `${secret} as bytes in ${where}`).to.equal(false);
      }
      // The strategy name never leaves the browser at all.
      expect(hay.includes(Buffer.from("Range trade")), `name in ${where}`).to.equal(false);
    }

    // Sanity: the ciphertext *is* there, so the search above was looking in the
    // right place rather than at an empty buffer.
    expect(account!.data.includes(Buffer.from(e.ciphertexts[0])), "ciphertext missing")
      .to.equal(true);
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
   * Emergency-withdrawal independence (SECURITY.md §8.1).
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
    // discriminator + 3 pubkeys + RiskLimits (20 bytes since size_bps joined it).
    // This test earns its keep: it failed the moment RiskLimits grew, which is
    // exactly when apps/web/lib/use-vault.ts started reading the wrong byte.
    const STATUS_OFFSET = 8 + 32 + 32 + 32 + 20;
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
