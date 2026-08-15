import { PublicKey } from "@solana/web3.js";

/**
 * Single source of truth for addresses shared by the program, the tests, and
 * the web app.
 *
 * These MUST stay in sync with `programs/vault/src/constants.rs`. A mismatch
 * between the frontend and the on-chain allowlist does not fail loudly — it
 * produces confusing rejections at signing time — so they live in one place.
 */

export const VAULT_PROGRAM_ID = new PublicKey(
  "J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ"
);

/** Wrapped SOL. Same address on every cluster. */
export const BASE_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

/** USDC. Devnet value; mainnet is EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v. */
export const QUOTE_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

export const VAULT_SEED = "vault";

export const BASE_DECIMALS = 9;
export const QUOTE_DECIMALS = 6;

export const BASE_SYMBOL = "SOL";
export const QUOTE_SYMBOL = "USDC";

/**
 * The vault config PDA is derived from the owner's address, which is what makes
 * a vault reachable only by its owner: a different signer derives a different
 * address and the program's seed constraint rejects it.
 */
export function deriveVaultPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), owner.toBuffer()],
    VAULT_PROGRAM_ID
  )[0];
}
