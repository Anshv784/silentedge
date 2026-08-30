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
 *
 * The two failure modes are reported separately, which they were not before.
 * Every error — including a dropped network request — used to surface as "No
 * MXE is deployed for this program yet." That sent a real investigation after a
 * missing deployment when the MXE was in fact live and active on cluster 456;
 * the actual fault was a flaky public RPC. A diagnosis the interface states
 * confidently and wrongly is worse than one it declines to make.
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
  } catch (e) {
    // Ask the RPC something trivial. If that fails too, the fault is the
    // connection and not the deployment, and saying so is the difference
    // between a five-minute fix and a wild goose chase.
    const reachable = await connection
      .getSlot()
      .then(() => true)
      .catch(() => false);

    if (!reachable) {
      return {
        live: false,
        key: DEV_KEY,
        reason:
          "Could not reach the Solana RPC, so the MPC cluster key could not be read. " +
          "This says nothing about whether an MXE is deployed — retry, or point " +
          "NEXT_PUBLIC_SOLANA_RPC_URL at an endpoint that is not rate-limited.",
      };
    }
    return {
      live: false,
      key: DEV_KEY,
      reason: `No MXE is deployed for this program yet (${
        e instanceof Error ? e.message : "unknown error"
      }).`,
    };
  }
}
