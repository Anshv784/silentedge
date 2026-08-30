import { NextResponse } from "next/server";

/**
 * Last price and 24-hour change, server-side.
 *
 * The Pyth Core upgrade of 26 August 2026 put every price endpoint behind an
 * API key. `hermes.pyth.network/v2/updates/price/latest` now answers 401, as
 * does the benchmarks equivalent, which is why the markets table rendered a
 * column of "no data" and the tape rendered nothing at all.
 *
 * What is still open is the history endpoint, and a last price is just the
 * most recent close. So a quote is derived here rather than read from a
 * dedicated feed: the newest bar gives the price, and the bar closest to
 * twenty-four hours earlier gives the change. That is the same arithmetic the
 * old code did against two Hermes observations — only the source moved.
 *
 * The hourly window is used rather than the minute one because it is a tenth
 * of the payload and a 24-hour change does not need minute resolution. The
 * cost is that "last" is the close of the current hour bar rather than a tick,
 * so it can lag a fast move by minutes. Anything that decides a trade reads the
 * on-chain Pyth account instead, never this.
 */

const PUBLIC = "https://web-api.pyth.network/history";

/** `Crypto.SOL/USD` and nothing shaped differently. */
const SYMBOL = /^Crypto\.[A-Z0-9]{1,20}\/USD$/;

/** Bounds the fan-out. One upstream call per symbol, so this is the ceiling. */
const MAX_SYMBOLS = 60;

/** Requests in flight at once, so a wide page does not open sixty sockets. */
const CONCURRENCY = 8;

export type Quote = { last: number; changePct: number | null; at: number };

type Bar = { timestamp: string; close_price: number };

async function quote(symbol: string): Promise<Quote | null> {
  const url = `${PUBLIC}?symbol=${encodeURIComponent(symbol)}&range=1W&cluster=pythnet`;
  const r = await fetch(url, {
    next: { revalidate: 60 },
    headers: { accept: "application/json" },
  });
  if (!r.ok) return null;
  const raw: Bar[] = await r.json();
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const bars = raw
    .map((b) => ({
      t: Math.floor(Date.parse(`${b.timestamp}Z`) / 1000),
      c: b.close_price,
    }))
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c) && b.c > 0)
    .sort((a, b) => a.t - b.t);
  if (bars.length === 0) return null;

  const newest = bars[bars.length - 1];
  const target = newest.t - 86_400;

  // The bar nearest a day before the newest one. Nearest rather than
  // first-older, so a feed with gaps compares against the closest real
  // observation instead of silently reaching back several days.
  let ref: { t: number; c: number } | null = null;
  for (const b of bars) {
    if (ref === null || Math.abs(b.t - target) < Math.abs(ref.t - target)) ref = b;
  }

  // Only call it a 24-hour change if the reference is actually near 24 hours
  // out. Otherwise report the price and leave the change null rather than
  // labelling a six-hour move as a daily one.
  const usable = ref !== null && Math.abs(ref.t - target) <= 3 * 3600 && ref.c > 0;
  return {
    last: newest.c,
    changePct: usable ? ((newest.c - ref!.c) / ref!.c) * 100 : null,
    at: newest.t,
  };
}

/** Resolve `jobs` with at most `limit` running at once. */
async function pooled<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("symbols") ?? "";
  const symbols = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];

  if (symbols.length === 0 || !symbols.every((s) => SYMBOL.test(s))) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const wanted = symbols.slice(0, MAX_SYMBOLS);
  const results = await pooled(
    wanted.map((s) => () => quote(s).catch(() => null)),
    CONCURRENCY
  );

  const quotes: Record<string, Quote> = {};
  wanted.forEach((s, i) => {
    const q = results[i];
    if (q) quotes[s] = q;
  });

  return NextResponse.json(
    // `truncated` is reported rather than silently dropped, so a caller asking
    // for more than the cap can tell that it did not get everything.
    { quotes, truncated: symbols.length > wanted.length ? symbols.length - wanted.length : 0 },
    { headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" } }
  );
}
