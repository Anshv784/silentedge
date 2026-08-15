"use client";

import { Connection, PublicKey } from "@solana/web3.js";
import { getMXEPublicKey } from "@arcium-hq/client";
import { AnchorProvider } from "@coral-xyz/anchor";

/**
 * The MXE cluster's x25519 public key — the key strategies are encrypted to.
 *
 * Until an MXE is deployed there is nothing real to encrypt to. Rather than
 * silently substituting a key nobody controls, this returns `live: false` so
 * the interface can say plainly that the strategy is not protected by a real
 * MPC cluster yet. A privacy claim the code cannot back is worse than no claim.
 */
export type MxeKey =
  | { live: true; key: Uint8Array }
  | { live: false; key: Uint8Array; reason: string };

/**
 * Development stand-in. Fixed and public on purpose: it must never be mistaken
 * for a key that protects anything.
 */
const DEV_KEY = new Uint8Array(32).fill(0x2a);

export async function fetchMxePublicKey(
  connection: Connection,
  programId: PublicKey
): Promise<MxeKey> {
  try {
    const key = await getMXEPublicKey(
      { connection } as unknown as AnchorProvider,
      programId
    );
    if (key && key.length === 32) return { live: true, key };
    return {
      live: false,
      key: DEV_KEY,
      reason: "No MXE is deployed for this program yet.",
    };
  } catch {
    return {
      live: false,
      key: DEV_KEY,
      reason: "No MXE is deployed for this program yet.",
    };
  }
}
