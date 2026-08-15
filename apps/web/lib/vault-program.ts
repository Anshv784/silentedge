"use client";

import { useMemo } from "react";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { BASE_MINT, QUOTE_MINT, deriveVaultPda, VAULT_PROGRAM_ID } from "@silentedge/config";
import type { EncryptedStrategy } from "@silentedge/sdk";
import { nonceToU128 } from "@silentedge/sdk";

// Build artifact. Run `anchor build` before building the web app.
import idl from "../../../target/idl/vault.json";

/**
 * Risk limits applied to new vaults.
 *
 * KNOWN LIMITATION: the program has no instruction to change these after
 * creation, so a vault is stuck with whatever it was made with. That is fine
 * while nothing enforces them, but an `update_limits` instruction (owner-only)
 * has to land alongside the trading phases, or users will be permanently bound
 * to these defaults. Tracked for the risk-controls phase.
 */
export const DEFAULT_LIMITS = {
  maxTradeBps: 1_000, // 10% of the vault per trade
  maxSlippageBps: 50, // 0.5%
  dailyLossLimitBps: 500, // 5%
  cooldownSeconds: 60,
  maxOracleStalenessSec: 30,
  maxConfBps: 100, // reject prices with >1% confidence/price
  maxOracleDeviationBps: 200, // 2%
};

export function useProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!wallet) return null;
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    return new Program(idl as never, provider) as Program;
  }, [connection, wallet]);
}

const ata = (owner: PublicKey, mint: PublicKey, offCurve = false) =>
  getAssociatedTokenAddressSync(mint, owner, offCurve);

export async function createVault(
  program: Program,
  owner: PublicKey
): Promise<string> {
  const vault = deriveVaultPda(owner);
  return program.methods
    .initializeVault(DEFAULT_LIMITS)
    .accountsPartial({
      owner,
      vaultConfig: vault,
      baseMint: BASE_MINT,
      quoteMint: QUOTE_MINT,
      vaultBaseAta: ata(vault, BASE_MINT, true),
      vaultQuoteAta: ata(vault, QUOTE_MINT, true),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function deposit(
  program: Program,
  owner: PublicKey,
  mint: PublicKey,
  amount: BN
): Promise<string> {
  const vault = deriveVaultPda(owner);
  return program.methods
    .deposit(amount)
    .accountsPartial({
      owner,
      vaultConfig: vault,
      mint,
      ownerAta: ata(owner, mint),
      vaultAta: ata(vault, mint, true),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

export async function withdraw(
  program: Program,
  owner: PublicKey,
  mint: PublicKey,
  amount: BN
): Promise<string> {
  const vault = deriveVaultPda(owner);
  const ownerAta = ata(owner, mint);

  // Withdrawing an asset the wallet has never held means no destination account
  // exists yet. Create it in the same transaction rather than failing with a
  // constraint error the user cannot act on.
  const preIx = [];
  const exists = await program.provider.connection.getAccountInfo(ownerAta);
  if (!exists) {
    preIx.push(
      createAssociatedTokenAccountInstruction(owner, ownerAta, owner, mint)
    );
  }

  return program.methods
    .withdraw(amount)
    .accountsPartial({
      owner,
      vaultConfig: vault,
      mint,
      ownerAta,
      vaultAta: ata(vault, mint, true),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(preIx)
    .rpc();
}

export function deriveStrategyPda(vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("strategy"), vault.toBuffer()],
    VAULT_PROGRAM_ID
  )[0];
}

/**
 * Store an encrypted strategy on chain.
 *
 * Only ciphertext, a nonce, and a public key cross this boundary. The plaintext
 * stays in page memory and is never serialized into a transaction, a log, or a
 * request.
 */
export async function submitStrategy(
  program: Program,
  owner: PublicKey,
  encrypted: EncryptedStrategy
): Promise<string> {
  const vault = deriveVaultPda(owner);
  return program.methods
    .submitStrategy(
      encrypted.ciphertexts.map((c) => Array.from(c)),
      new BN(nonceToU128(encrypted.nonce).toString()),
      Array.from(encrypted.encryptionPublicKey)
    )
    .accountsPartial({
      owner,
      vaultConfig: vault,
      strategyState: deriveStrategyPda(vault),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Turn an Anchor/RPC error into something a person can act on. */
export function readableError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/User rejected|rejected the request/i.test(text)) {
    return "You declined the transaction.";
  }
  const code = text.match(
    /(ZeroAmount|InsufficientBalance|VaultNotActive|VaultStopped|MintNotAllowed|InvalidRiskLimit|NotPauseAuthority|InvalidEncryptionKey)/
  )?.[1];
  switch (code) {
    case "ZeroAmount":
      return "Enter an amount above zero.";
    case "InsufficientBalance":
      return "The vault does not hold that much.";
    case "VaultNotActive":
      return "Deposits are paused for this vault.";
    case "VaultStopped":
      return "This vault is stopped.";
    case "MintNotAllowed":
      return "That token is not supported.";
    case "InvalidEncryptionKey":
      return "The encryption key was not usable. Reconnect your wallet and try again.";
    default:
      break;
  }
  if (/insufficient lamports|0x1\b/i.test(text)) {
    return "Not enough balance to cover this transaction.";
  }
  return text.split("\n")[0].slice(0, 160);
}
