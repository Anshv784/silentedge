"use client";

import { Connection, PublicKey } from "@solana/web3.js";
import { QUOTE_DECIMALS, BASE_DECIMALS } from "@silentedge/config";

/**
 * A vault's own history, read from the chain rather than remembered by the app.
 *
 * The dashboard used to show only receipts from the current session, so a
 * refresh emptied it and anything the executor did was invisible — a user could
 * not tell "nothing has happened" from "I wasn't watching". These come from the
 * vault's transaction history, so they are the same for everyone and survive a
 * reload.
 */

export type ActivityKind =
  | "deposit"
  | "withdraw"
  | "trade"
  | "authorization"
  | "held"
  | "strategy"
  | "limits"
  | "status"
  | "other";

export type Activity = {
  signature: string;
  kind: ActivityKind;
  /** Unix seconds from the chain, not the browser clock. */
  at: number | null;
  summary: string;
  failed: boolean;
};

/** Log markers Anchor emits for each instruction, in program-log form. */
const INSTRUCTION_MARKERS: [RegExp, ActivityKind, string][] = [
  [/Instruction: Deposit/, "deposit", "Deposit"],
  [/Instruction: Withdraw/, "withdraw", "Withdrawal"],
  [/Instruction: ExecuteTrade/, "trade", "Trade executed"],
  [/Instruction: EvaluateStrategyV3Callback/, "authorization", "Strategy evaluated"],
  [/Instruction: SubmitStrategy/, "strategy", "Strategy submitted"],
  [/Instruction: ConvertStrategy/, "strategy", "Strategy handed to the cluster"],
  [/Instruction: UpdateLimits/, "limits", "Risk limits changed"],
  [/Instruction: Pause/, "status", "Trading paused"],
  [/Instruction: Resume/, "status", "Trading resumed"],
  [/Instruction: Stop/, "status", "Vault stopped"],
  [/Instruction: InitializeVault/, "other", "Vault created"],
  [/Instruction: InitTradeIntent/, "other", "Authorization slot created"],
];

/**
 * Read recent vault activity.
 *
 * Deliberately derived from program logs rather than decoded event data: the
 * marker lines are stable across IDL changes and a missing one degrades to
 * "other" instead of throwing. Nothing here is authoritative for money — it is
 * a history view, and the balances beside it come from the token accounts.
 */
export async function readActivity(
  connection: Connection,
  vault: PublicKey,
  limit = 12
): Promise<Activity[]> {
  const sigs = await connection.getSignaturesForAddress(vault, { limit }, "confirmed");
  if (sigs.length === 0) return [];

  const out: Activity[] = [];
  for (const s of sigs) {
    const tx = await connection
      .getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .catch(() => null);

    const logs = tx?.meta?.logMessages ?? [];
    let kind: ActivityKind = "other";
    let summary = "Vault activity";
    for (const [re, k, label] of INSTRUCTION_MARKERS) {
      if (logs.some((l) => re.test(l))) {
        kind = k;
        summary = label;
        break;
      }
    }
    // A callback that decided not to trade is a real, informative outcome —
    // "the strategy looked and did nothing" rather than "nothing happened".
    if (kind === "authorization" && logs.some((l) => /EvaluationHeld/.test(l))) {
      kind = "held";
      summary = "Strategy evaluated — no trade";
    }

    out.push({
      signature: s.signature,
      kind,
      at: s.blockTime ?? null,
      summary,
      failed: Boolean(s.err),
    });
  }
  return out;
}

/**
 * Value of the two balances in quote terms, using the oracle price.
 *
 * This is a *valuation*, not profit and loss. The protocol keeps no cost basis
 * — deposits and withdrawals move either mint without recording what it was
 * worth — so realised or unrealised P&L cannot be computed from on-chain state
 * and is not shown. Inventing one would be the same mistake the daily-loss
 * limit was rejected for (SECURITY_AUDIT, T-31).
 */
export function vaultValueInQuote(
  quote: number | null,
  base: number | null,
  priceUsd: number | null
): number | null {
  if (quote === null || base === null || priceUsd === null) return null;
  return quote + base * priceUsd;
}

/** SOL/USD from the Pyth account the program itself reads. */
export async function readOraclePrice(
  connection: Connection,
  pyth: PublicKey
): Promise<{ price: number; publishedAt: number } | null> {
  const acc = await connection.getAccountInfo(pyth).catch(() => null);
  if (!acc || acc.data.length < 110) return null;
  // disc(8) + write_authority(32) + verification_level(1) + feed_id(32) = 73
  const raw = acc.data.readBigInt64LE(73);
  const exponent = acc.data.readInt32LE(89);
  const publishedAt = Number(acc.data.readBigInt64LE(93));
  const price = Number(raw) * Math.pow(10, exponent);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, publishedAt };
}

export { QUOTE_DECIMALS, BASE_DECIMALS };
