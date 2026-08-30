import { NextResponse } from "next/server";

/**
 * The on-chain price the program actually trades against.
 *
 * Read here rather than in the browser for one reason: decoding it needs a
 * Solana RPC client, and pulling `@solana/web3.js` into the marketing page to
 * print one number would cost more than every other byte on it combined. This
 * route does a raw JSON-RPC call with `fetch` — no SDK, no client bundle.
 *
 * It is deliberately not the same source as `/api/candles`. Those are display
 * candles relayed from Pyth's public history. THIS is the `PriceUpdateV2`
 * account the deployed program reads, validates for staleness and confidence,
 * and decides a trade from. The distinction is the whole point of showing it:
 * the landing page prints the number the machine runs on, not a chart feed
 * that happens to agree with it.
 *
 * Byte offsets match `apps/web/lib/activity.ts`, which decodes the same account
 * for the app.
 */

const RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  "https://api.devnet.solana.com";

const ORACLE =
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";

export async function GET() {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [ORACLE, { encoding: "base64", commitment: "confirmed" }],
      }),
    });
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    const j = await r.json();
    const b64 = j?.result?.value?.data?.[0];
    const slot = j?.result?.context?.slot ?? null;
    if (typeof b64 !== "string") throw new Error("no account data");

    const buf = Buffer.from(b64, "base64");
    // PriceUpdateV2: i64 price @73, i32 exponent @89, i64 publish_time @93.
    const raw = buf.readBigInt64LE(73);
    const exponent = buf.readInt32LE(89);
    const publishedAt = Number(buf.readBigInt64LE(93));
    const price = Number(raw) * 10 ** exponent;

    if (!Number.isFinite(price) || price <= 0) throw new Error("bad price");

    return NextResponse.json(
      { price, publishedAt, slot, account: ORACLE },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    // A failure here must not blank the page: the caller falls back to the
    // relayed display candles and labels which source it is showing.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unavailable" },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}
