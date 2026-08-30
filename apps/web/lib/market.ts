"use client";

/**
 * Market data, kept strictly out of the execution path.
 *
 * There are two different things called "the price" here and conflating them
 * would be a security bug, not a UI one:
 *
 *   the execution price — the Pyth `PriceUpdateV2` account the *program* reads
 *                         and validates (freshness, confidence, sanity band).
 *                         Nothing in this file can influence it.
 *
 *   the display price   — history and indicators fetched over HTTP from Pyth's
 *                         public benchmarks API, for charts and context only.
 *
 * Same publisher, different transport and no on-chain attestation on the
 * second one. It is fine for drawing a line and unfit for deciding a trade, so
 * it is fetched here, in the browser, and never handed to anything that signs.
 *
 * One deliberate omission: Pyth's history returns a `v` (volume) array and it
 * is all zeros — Pyth publishes prices, not trades. So there are no volume
 * bars anywhere in this app. Drawing a flat row of zero bars, or synthesising
 * volume from price movement, would be a chart that looks like a centralized
 * exchange while reporting a number nobody measured.
 */

/* Deep import, not the barrel. `@silentedge/sdk` re-exports arcium.ts and
   encrypt.ts, so importing one pure formatting helper from the top level
   dragged @solana/web3.js, bn.js and the whole Arcium client into every page
   that shows a price — including the marketing page, which has no wallet. */
import { decimalsFor } from "@silentedge/sdk/indicators";
import { fetchFeeds } from "@/lib/pyth";

/**
 * Candles come from our own origin, not from Pyth directly.
 *
 * `app/api/candles/route.ts` relays them. The browser cannot call the
 * benchmarks endpoint reliably — it rate-limits on burst and its rejections
 * carry no CORS header, so the failure surfaces as a vanished chart. Going
 * through the server collapses every visitor's request into one upstream call
 * and keeps a last-good copy to serve while upstream is refusing.
 */
const BENCHMARKS = "/api/candles";

/* ------------------------------------------------------------------ pairs */

export type Pair = {
  /** Pyth ticker, e.g. "Crypto.SOL/USD". What the candle endpoint takes. */
  id: string;
  label: string;
  base: string;
  /** Hermes feed id, when the pair came from the fetched catalog. */
  feedId?: string;
  /**
   * Whether *this vault* can trade it. Exactly one pair is true and that is a
   * property of the deployed program, not a setting: the base and quote mints
   * are compiled into `programs/vault`. Every other pair on this page is
   * analysis, and is labelled that way wherever it appears.
   */
  tradable: boolean;
};

const pair = (base: string, tradable = false): Pair => ({
  id: `Crypto.${base}/USD`,
  label: `${base} / USD`,
  base,
  tradable,
});

/**
 * The pairs shown before anyone searches. Ordered by how likely a Solana user
 * is to want them, with the one tradable pair first.
 */
export const POPULAR: Pair[] = [
  pair("SOL", true),
  pair("BTC"),
  pair("ETH"),
  pair("BNB"),
  pair("XRP"),
  pair("DOGE"),
  pair("ADA"),
  pair("AVAX"),
  pair("LINK"),
  pair("SUI"),
  pair("APT"),
  pair("TON"),
  pair("HYPE"),
  pair("JUP"),
  pair("PYTH"),
  pair("JTO"),
  pair("RAY"),
  pair("BONK"),
  pair("WIF"),
  pair("W"),
  pair("TRUMP"),
  pair("DOT"),
  pair("NEAR"),
  pair("ARB"),
  pair("OP"),
  pair("TIA"),
  pair("SEI"),
  pair("INJ"),
  pair("LTC"),
  pair("ATOM"),
];

/**
 * Kept for the pages that only ever deal with the tradable pair. `PAIRS[0]` is
 * SOL and always will be — the backtest and the strategy studio index into it.
 */
export const PAIRS = [POPULAR[0]] as const;

/** The vault's pair, by definition rather than by position in a list. */
export const TRADABLE = POPULAR.find((p) => p.tradable)!;

/* ------------------------------------------------------------ resolutions */

export type Resolution =
  | "5S"
  | "15S"
  | "1"
  | "5"
  | "15"
  | "30"
  | "60"
  | "240"
  | "720"
  | "D"
  | "W";

export type Timeframe = {
  label: string;
  resolution: Resolution;
  /** Seconds each candle covers, used to size the history window. */
  seconds: number;
};

/** The set Pyth's `/config` endpoint reports as supported, trimmed to useful. */
export const TIMEFRAMES: Timeframe[] = [
  // The two sub-minute steps exist because the upstream window genuinely
  // publishes five-second bars. Anything coarser makes a live chart look
  // frozen between updates.
  { label: "5s", resolution: "5S", seconds: 5 },
  { label: "15s", resolution: "15S", seconds: 15 },
  { label: "1m", resolution: "1", seconds: 60 },
  { label: "5m", resolution: "5", seconds: 300 },
  { label: "15m", resolution: "15", seconds: 900 },
  { label: "30m", resolution: "30", seconds: 1_800 },
  { label: "1H", resolution: "60", seconds: 3_600 },
  { label: "4H", resolution: "240", seconds: 14_400 },
  { label: "12H", resolution: "720", seconds: 43_200 },
  { label: "1D", resolution: "D", seconds: 86_400 },
  { label: "1W", resolution: "W", seconds: 604_800 },
];

export const DEFAULT_TIMEFRAME = 4; // 1H

/**
 * Legacy window presets, still used by the backtest page and the strategy
 * studio, where the question is "over what stretch of history" rather than
 * "at what candle size".
 */
export const RANGES: { label: string; days: number; resolution: Resolution }[] =
  [
    { label: "24h", days: 1, resolution: "60" },
    { label: "7d", days: 7, resolution: "60" },
    { label: "30d", days: 30, resolution: "240" },
    { label: "1y", days: 365, resolution: "D" },
  ];

/* ------------------------------------------------------------------ fetch */

export type Candle = { t: number; o: number; h: number; l: number; c: number };

/**
 * One request per distinct window, briefly.
 *
 * Three things on screen want history at once — the tape, the terminal and the
 * markets table — and the benchmarks endpoint *drops* requests when they
 * arrive as a burst. A dropped response carries no CORS header, so the browser
 * reports it as a CORS failure rather than as the rate limit it is, which is a
 * confusing way to lose a chart.
 *
 * So identical in-flight requests share one promise, recent answers are reused
 * for a few seconds, and a failure is retried once after a short pause. The
 * TTL is deliberately shorter than the fastest poll interval on any page, so
 * nothing is served staler than it would have been without the cache.
 */
const TTL_MS = 12_000;
const cache = new Map<string, { at: number; data: Candle[] }>();
const inflight = new Map<string, Promise<Candle[]>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function history(
  symbol: string,
  resolution: Resolution,
  from: number,
  to: number
): Promise<Candle[]> {
  const url =
    `${BENCHMARKS}?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${resolution}&from=${from}&to=${to}`;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const running = inflight.get(url);
  if (running) return running;

  const job = (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(400 + attempt * 600);
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`history unavailable (${r.status})`);
        const j = await r.json();
        // `s` is "ok" | "no_data" | "error". A pair Pyth does not publish
        // returns no_data, which is an empty chart rather than a failure.
        if (j.s !== "ok" || !Array.isArray(j.t)) return [];
        const out: Candle[] = [];
        for (let i = 0; i < j.t.length; i++) {
          const c = { t: j.t[i], o: j.o[i], h: j.h[i], l: j.l[i], c: j.c[i] };
          if ([c.o, c.h, c.l, c.c].every((n) => Number.isFinite(n) && n > 0)) {
            out.push(c);
          }
        }
        cache.set(url, { at: Date.now(), data: out });
        return out;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("history unavailable");
  })().finally(() => inflight.delete(url));

  inflight.set(url, job);
  return job;
}

/**
 * `to` is quantised to a 10-second grid rather than taken from the clock.
 *
 * Two callers a second apart would otherwise build URLs that differ only in
 * their final digit, miss each other in the cache, and issue the duplicate
 * request the cache exists to prevent.
 */
const now = () => Math.floor(Date.now() / 10_000) * 10;

/** Window expressed in days, for the backtest and studio. */
export async function fetchHistory(
  symbol: string,
  days: number,
  resolution: Resolution
): Promise<Candle[]> {
  const to = now();
  return history(symbol, resolution, to - days * 86_400, to);
}

/** Window expressed in candles, for the terminal. */
export async function fetchCandles(
  symbol: string,
  tf: Timeframe,
  bars = 500
): Promise<Candle[]> {
  const to = now();
  return history(symbol, tf.resolution, to - tf.seconds * bars, to);
}

/* ---------------------------------------------------------------- catalog */

let catalogPromise: Promise<Pair[]> | null = null;

/**
 * Every crypto/USD pair Pyth publishes, fetched rather than baked in.
 *
 * Sourced from Hermes because that response carries the feed id the quote
 * endpoints need *and* the same `Crypto.X/USD` ticker the candle endpoint
 * takes, so one request produces a catalog usable by both.
 *
 * `tradable` is computed against the vault's pair, so a new listing upstream
 * can never accidentally present itself as something this vault can trade.
 */
export function fetchCatalog(): Promise<Pair[]> {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const feeds = await fetchFeeds();
    const pairs: Pair[] = feeds.map((f) => ({
      id: f.symbol,
      label: `${f.base} / USD`,
      base: f.base,
      feedId: f.id,
      tradable: f.symbol === TRADABLE.id,
    }));
    const rank = (p: Pair) => {
      const i = POPULAR.findIndex((q) => q.id === p.id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    pairs.sort((a, b) => rank(a) - rank(b) || a.base.localeCompare(b.base));
    return pairs.length > 0 ? pairs : POPULAR;
  })().catch(() => {
    catalogPromise = null;
    return POPULAR;
  });
  return catalogPromise;
}

/* -------------------------------------------------------------- summarise */

/**
 * Summary statistics, all derived here from the display series.
 *
 * Labelled as derived in the UI because the distinction matters: none of these
 * are inputs the program can see, and none are things the strategy can act on.
 * The circuit compares a price to fixed thresholds — it has no moving average
 * and no volatility term — so presenting a statistic next to a strategy must
 * not imply the strategy uses it.
 */
export function summarize(candles: Candle[]) {
  if (candles.length === 0) return null;
  const closes = candles.map((c) => c.c).filter((n) => Number.isFinite(n));
  if (closes.length === 0) return null;

  const first = closes[0];
  const last = closes[closes.length - 1];
  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;

  // Log-return standard deviation, annualised by the candle spacing. A summary
  // statistic, not a forecast.
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const rMean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance =
    rets.reduce((a, b) => a + (b - rMean) ** 2, 0) / (rets.length || 1);
  const spacingSec = candles.length > 1 ? candles[1].t - candles[0].t : 3_600;
  const periodsPerYear = (365 * 86_400) / (spacingSec || 3_600);
  const volAnnual = Math.sqrt(variance * periodsPerYear);

  // Largest peak-to-trough fall within the window.
  let peak = closes[0];
  let maxDrawdown = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = peak > 0 ? (peak - c) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    first,
    last,
    changePct: first > 0 ? ((last - first) / first) * 100 : 0,
    high,
    low,
    mean,
    volAnnualPct: volAnnual * 100,
    maxDrawdownPct: maxDrawdown * 100,
    points: closes.length,
  };
}

/** A polyline path for an inline SVG sparkline — no charting dependency. */
export function sparkPath(
  candles: Candle[],
  width: number,
  height: number,
  pad = 2
): string {
  if (candles.length < 2) return "";
  const closes = candles.map((c) => c.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (closes.length - 1);
  return closes
    .map((c, i) => {
      const x = pad + i * stepX;
      const y = pad + (height - pad * 2) * (1 - (c - min) / span);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/* ------------------------------------------------------------- formatting */

/**
 * Price precision, from the SDK so the chart axis, the price readout and the
 * indicator panel cannot disagree about how precise a number is.
 */
export { decimalsFor as precisionFor } from "@silentedge/sdk/indicators";

export function price(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const dp = decimalsFor(n);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: Math.min(dp, 2),
    maximumFractionDigits: dp,
  });
}

export function pct(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;
}

/* ------------------------------------------------------------ concurrency */

/**
 * Run `jobs` with a ceiling on how many are in flight.
 *
 * The markets list needs one request per row. Firing five hundred at once gets
 * the browser to queue them anyway and gets us rate-limited by Pyth, so the
 * list fetches only the rows it is about to show, a few at a time.
 */
export async function pooled<T>(
  jobs: (() => Promise<T>)[],
  limit = 4
): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        out[i] = await jobs[i]();
      }
    })
  );
  return out;
}
