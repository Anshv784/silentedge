"use client";

/**
 * The pair catalogue, and quotes for it.
 *
 * This file used to talk to Hermes for both. The Pyth Core upgrade of
 * 26 August 2026 changed that in two ways, and both had to be found by
 * probing the live endpoints rather than by reading the code:
 *
 *   - `hermes.pyth.network/v2/updates/price/latest` now answers **401
 *     unauthorized**, as does every other price endpoint including the
 *     benchmarks one. There is no unauthenticated live-price API left.
 *
 *   - `hermes.pyth.network/v2/price_feeds` still answers 200, but its
 *     attributes no longer carry `base`. The old parser required that field
 *     and therefore silently dropped every one of the 411 feeds, which is why
 *     the markets table fell back to a 30-row shortlist.
 *
 * So the catalogue is still read from Hermes, with `base` derived from the
 * `Crypto.SOL/USD` symbol it does still publish, and quotes come from
 * `app/api/quotes` on our own origin — which derives a last price and a
 * 24-hour change from the one Pyth endpoint that is still open. See that
 * route for what the derivation costs in precision.
 *
 * None of this is the execution price. That is an on-chain `PriceUpdateV2`
 * account the program reads and validates itself; nothing in this file can
 * influence a trade.
 */

const HERMES = "https://hermes.pyth.network/v2";

/** Matches the cap in `app/api/quotes/route.ts`. */
const CHUNK = 60;

export type Feed = {
  /** 32-byte feed id, hex, no 0x. */
  id: string;
  /** Pyth ticker, e.g. `Crypto.SOL/USD`. Also what the candle relay takes. */
  symbol: string;
  base: string;
  description: string;
};

let feedsPromise: Promise<Feed[]> | null = null;

/**
 * Every crypto/USD feed Pyth publishes, in one request.
 *
 * Fetched rather than baked in: a hardcoded list goes stale silently. `base`
 * is parsed out of `symbol` because the attribute that used to carry it was
 * removed upstream — `Crypto.SOL/USD` yields `SOL`. Non-USD quotes are
 * dropped; they are real, but they are not prices a trader reads the same way.
 */
export function fetchFeeds(): Promise<Feed[]> {
  if (feedsPromise) return feedsPromise;
  feedsPromise = (async () => {
    const r = await fetch(`${HERMES}/price_feeds?asset_type=crypto`);
    if (!r.ok) throw new Error(`feed list unavailable (${r.status})`);
    const raw = (await r.json()) as {
      id: string;
      attributes: Record<string, string>;
    }[];
    const out: Feed[] = [];
    for (const f of raw) {
      const a = f.attributes ?? {};
      if (a.quote_currency !== "USD" || !a.symbol) continue;
      const m = /^Crypto\.([A-Z0-9]{1,20})\/USD$/.exec(a.symbol);
      if (!m) continue;
      out.push({
        id: f.id,
        symbol: a.symbol,
        base: m[1],
        description: a.description ?? `${m[1]} / US DOLLAR`,
      });
    }
    return out;
  })().catch((e) => {
    // Let the next caller retry rather than caching the failure forever.
    feedsPromise = null;
    throw e;
  });
  return feedsPromise;
}

export type Quote = {
  last: number;
  /** null when there is no observation close enough to 24 hours back. */
  changePct: number | null;
  /** Close time of the bar the price came from. */
  publishTime: number;
};

type QuoteResponse = {
  quotes: Record<string, { last: number; changePct: number | null; at: number }>;
};

/**
 * Current price and 24-hour change, keyed by feed id.
 *
 * `onLatest` is retained from the version that made two passes against Hermes
 * — one fast, one slow — so callers that render prices early still work. The
 * relay answers both halves at once now, so it fires once with the whole set
 * immediately before the promise settles.
 */
export async function fetchQuotes(
  feeds: Feed[],
  onLatest?: (partial: Map<string, Quote>) => void
): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (feeds.length === 0) return out;

  const bySymbol = new Map(feeds.map((f) => [f.symbol, f.id]));

  for (let i = 0; i < feeds.length; i += CHUNK) {
    const batch = feeds.slice(i, i + CHUNK);
    try {
      const r = await fetch(
        `/api/quotes?symbols=${encodeURIComponent(batch.map((f) => f.symbol).join(","))}`
      );
      if (!r.ok) continue;
      const j = (await r.json()) as QuoteResponse;
      for (const [symbol, q] of Object.entries(j.quotes ?? {})) {
        const id = bySymbol.get(symbol);
        if (!id || !Number.isFinite(q.last) || q.last <= 0) continue;
        out.set(id, {
          last: q.last,
          changePct: Number.isFinite(q.changePct as number) ? q.changePct : null,
          publishTime: q.at,
        });
      }
    } catch {
      // A batch that fails leaves its rows unpriced rather than failing the
      // whole list — a table with four blanks beats an empty one.
    }
  }

  onLatest?.(out);
  return out;
}
