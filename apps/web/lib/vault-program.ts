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
import {
  nonceToU128,
  arciumAccounts,
  CIRCUIT_STORE,
  freshComputationOffset,
} from "@silentedge/sdk";

/** Must match the vault program's compiled-in EXPECTED_CLUSTER_OFFSET. */
const CLUSTER_OFFSET = Number(
  process.env.NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET ?? 456
);

// Build artifact. Run `anchor build` before building the web app.
import idl from "../../../target/idl/vault.json";

/**
 * Risk limits applied to new vaults.
 *
 * Changeable after creation: `update_limits` is owner-only and bumps the vault
 * nonce, which invalidates any authorization already in flight. `sizeBps` lives
 * here rather than in the encrypted strategy because a single trade recovers it
 * exactly from public data (THREAT_MODEL T-38).
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

/**
 * Hand the submitted strategy to the MPC cluster.
 *
 * The step that makes an unattended bot possible, and the only one nobody else
 * can do for you: `convert_strategy` derives `vault_config` from the *payer*,
 * so it needs the owner's signature. It re-encrypts `Enc<Shared, Strategy>`
 * (readable by you) into `Enc<Mxe, Strategy>` (readable only by the cluster
 * acting together), after which evaluations need no one online.
 *
 * Until this runs, `strategy_state.mxe_version` is 0 and every evaluation is
 * refused with `StrategyNotConverted` — a submitted strategy that was never
 * converted is inert, not private-and-working.
 */
export async function convertStrategy(
  program: Program,
  owner: PublicKey
): Promise<string> {
  const vault = deriveVaultPda(owner);
  const offset = freshComputationOffset();
  return program.methods
    .convertStrategy(new BN(offset.toString()))
    .accountsPartial({
      payer: owner,
      vaultConfig: vault,
      strategyState: deriveStrategyPda(vault),
      ...arciumAccounts(VAULT_PROGRAM_ID, CLUSTER_OFFSET, offset, CIRCUIT_STORE),
    })
    .rpc({ skipPreflight: true });
}

/** `strategy_state.mxe_version`, or 0 if the strategy has never been stored. */
export async function readMxeVersion(
  program: Program,
  owner: PublicKey
): Promise<number> {
  const vault = deriveVaultPda(owner);
  const s: any = await (program.account as any).strategyState
    .fetch(deriveStrategyPda(vault))
    .catch(() => null);
  return s ? Number(s.mxeVersion) : 0;
}

/**
 * Spend a pending authorization yourself.
 *
 * The point of this button is independence: `execute_trade` is permissionless,
 * so if our executor is down, slow, or hostile, the owner can close the loop
 * from their own browser with their own fee payer. Nothing about the trade
 * changes — the side, the size, the expiry and the oracle floor were all fixed
 * by the verified callback, and the program re-checks every one of them.
 */
export async function selfExecute(
  program: Program,
  owner: PublicKey,
  intent: { side: number; amountIn: bigint }
): Promise<string> {
  const vault = deriveVaultPda(owner);
  const inputMint = intent.side === 1 ? QUOTE_MINT : BASE_MINT;
  const outputMint = intent.side === 1 ? BASE_MINT : QUOTE_MINT;

  const url =
    `https://api.jup.ag/swap/v2/build?inputMint=${inputMint.toBase58()}` +
    `&outputMint=${outputMint.toBase58()}&amount=${intent.amountIn}` +
    `&taker=${vault.toBase58()}&maxAccounts=24&onlyDirectRoutes=true` +
    `&wrapAndUnwrapSol=false&slippageBps=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not get a route (${res.status}).`);
  const j = await res.json();
  if (!j.swapInstruction) throw new Error("No route is available right now.");
  const si = j.swapInstruction;

  return program.methods
    .executeTrade(Buffer.from(si.data, "base64"))
    .accountsPartial({
      executor: owner,
      vaultConfig: vault,
      tradeIntent: deriveIntentPda(vault),
      strategyState: deriveStrategyPda(vault),
      vaultQuoteAta: getAssociatedTokenAddressSync(QUOTE_MINT, vault, true),
      vaultBaseAta: getAssociatedTokenAddressSync(BASE_MINT, vault, true),
      priceUpdate: new PublicKey(
        process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
          "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
      ),
      jupiterProgram: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
    })
    .remainingAccounts(
      si.accounts.map((a: any) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: false, // the vault PDA signs via invoke_signed, not here
        isWritable: a.isWritable,
      }))
    )
    .rpc({ skipPreflight: true });
}

export function deriveIntentPda(vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), vault.toBuffer()],
    VAULT_PROGRAM_ID
  )[0];
}

/** The pending authorization, if there is a spendable one. */
export async function readPendingIntent(
  program: Program,
  owner: PublicKey
): Promise<{ side: number; amountIn: bigint; expiresAtSlot: bigint } | null> {
  const vault = deriveVaultPda(owner);
  const i: any = await (program.account as any).tradeIntent
    .fetch(deriveIntentPda(vault))
    .catch(() => null);
  if (!i || i.consumed || BigInt(i.amountIn.toString()) === 0n) return null;
  return {
    side: Number(i.side),
    amountIn: BigInt(i.amountIn.toString()),
    expiresAtSlot: BigInt(i.expiresAtSlot.toString()),
  };
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
