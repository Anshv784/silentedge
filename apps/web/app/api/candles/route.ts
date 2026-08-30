import { NextResponse } from "next/server";
import { resample, type Candle } from "@silentedge/sdk/candles";

/**
 * Candles, server-side.
 *
 * Pyth retired `benchmarks.pyth.network/v1/shims/tradingview/*` on
 * 26 August 2026 at 16:00 UTC as part of the Pyth Core upgrade. Every one of
 * those endpoints now returns 404, which is why the terminal was rendering
 * "No chart" — the failure was upstream, not local, and no amount of retrying
 * was going to fix it.
 *
 * Two sources replace it, in order of preference:
 *
 *  1. The **Pyth Pro History API**, the official migration path, which speaks
 *     the same TradingView UDF shape. It needs `PYTH_PRO_API_KEY`, and Pyth's
 *     own documentation says that key must never reach a browser — so it is
 *     read here, on the server, and never sent to the client. If the variable
 *     is absent this route silently uses (2); it does not invent a key.
 *
 *  2. `web-api.pyth.network/history`, unauthenticated, which serves four fixed
 *     windows at fixed granularities. Anything else is resampled from those.
 *     This is the public endpoint Pyth's own site uses; it is not a documented
 *     product surface, so it is the fallback rather than the default.
 *
 * Either way the browser talks only to this origin. That is what makes the
 * chart reliable: requests from every visitor collapse into one upstream call
 * per window, there is no CORS to fail, and `connect-src 'self'` already
 * permits it without widening the policy.
 */

const PRO = "https://pyth.dourolabs.app/v1";
const PRO_CHANNEL = "fixed_rate@200ms";
const PUBLIC = "https://web-api.pyth.network/history";

const SECONDS: Record<string, number> = {
  // Seconds, in TradingView's own notation. The public window serves bars at a
  // true five-second cadence — measured, not assumed — and without these two
  // entries the finest resolution reachable was a minute, so a "live" chart
  // moved once every sixty seconds.
  "5S": 5,
  "15S": 15,
  "1": 60,
  "5": 300,
  "15": 900,
  "30": 1800,
  "60": 3600,
  "240": 14_400,
  "720": 43_200,
  D: 86_400,
  W: 604_800,
};

/** `Crypto.SOL/USD` and nothing shaped differently. */
const SYMBOL = /^Crypto\.[A-Z0-9]{1,20}\/USD$/;

type Udf = { s: string; t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };

const toUdf = (bars: Candle[]): Udf => ({
  s: bars.length > 0 ? "ok" : "no_data",
  t: bars.map((b) => b.t),
  o: bars.map((b) => b.o),
  h: bars.map((b) => b.h),
  l: bars.map((b) => b.l),
  c: bars.map((b) => b.c),
});

/**
 * The smallest public window that is both fine enough to build the requested
 * bucket and long enough to cover the requested span.
 *
 * Granularities measured against the live endpoint: 1H serves 5-10s bars over
 * an hour, 1D serves 60s bars over a day, and 1W and 1M both serve hourly bars
 * over seven and thirty days. So a bucket under a minute needs 1H, anything
 * under an hour needs 1D, and the rest come from the hourly windows.
 */
function windowFor(bucket: number, span: number): "1H" | "1D" | "1W" | "1M" {
  if (bucket < 60) return "1H";
  if (bucket < 3600) return "1D";
  return span <= 7 * 86_400 ? "1W" : "1M";
}

type PublicBar = {
  timestamp: string;
  open_price: number;
  high_price: number;
  low_price: number;
  close_price: number;
};

async function fromPublic(symbol: string, bucket: number, span: number): Promise<Candle[]> {
  const range = windowFor(bucket, span);
  const url = `${PUBLIC}?symbol=${encodeURIComponent(symbol)}&range=${range}&cluster=pythnet`;
  // Cache for a fraction of the bucket, floored at five seconds: a
  // thirty-second cache would hand a five-second chart the same bar six times
  // in a row, which looks exactly like a frozen feed.
  const revalidate = Math.max(5, Math.min(30, Math.floor(bucket / 2)));
  const r = await fetch(url, { next: { revalidate }, headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`public history ${r.status}`);
  const raw: PublicBar[] = await r.json();
  if (!Array.isArray(raw)) throw new Error("public history returned no array");

  const bars: Candle[] = [];
  for (const b of raw) {
    // Timestamps arrive without a zone designator and are UTC.
    const t = Math.floor(Date.parse(`${b.timestamp}Z`) / 1000);
    const o = b.open_price;
    const h = b.high_price;
    const l = b.low_price;
    const c = b.close_price;
    if (!Number.isFinite(t)) continue;
    if (![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue;
    bars.push({ t, o, h, l, c });
  }
  return resample(bars, bucket);
}

async function fromPro(
  symbol: string,
  resolution: string,
  from: number,
  to: number,
  key: string
): Promise<Candle[]> {
  const url =
    `${PRO}/${PRO_CHANNEL}/history?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${resolution}&from=${from}&to=${to}`;
  const r = await fetch(url, {
    next: { revalidate: 30 },
    headers: { accept: "application/json", authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`pro history ${r.status}`);
  const j: Udf = await r.json();
  if (j.s !== "ok" || !Array.isArray(j.t)) return [];
  const bars: Candle[] = [];
  for (let i = 0; i < j.t.length; i++) {
    const bar = { t: j.t[i], o: j.o[i], h: j.h[i], l: j.l[i], c: j.c[i] };
    if ([bar.o, bar.h, bar.l, bar.c].every((n) => Number.isFinite(n) && n > 0)) bars.push(bar);
  }
  return bars;
}

/**
 * Last good answer per key, served while upstream is failing.
 *
 * A transient upstream error is not a reason to blank a chart the user is
 * looking at. Bounded, and stamped, so the client can say the data is not live
 * rather than implying these candles are current.
 */
const LAST_GOOD = new Map<string, { at: number; bars: Candle[] }>();
const MAX_KEYS = 400;
const STALE_MS = 10 * 60 * 1000;

/**
 * Refresh one window in the background. Deliberately fire-and-forget: the
 * caller has already been answered from memory, so a failure here must not
 * surface as an error on a request that succeeded.
 */
async function refresh(
  symbol: string,
  resolution: string,
  from: number,
  to: number,
  bucket: number,
  span: number,
  key: string,
  proKey: string | undefined
) {
  try {
    let bars = proKey
      ? await fromPro(symbol, resolution, from, to, proKey).catch(() =>
          fromPublic(symbol, bucket, span)
        )
      : await fromPublic(symbol, bucket, span);
    bars = bars.filter((b) => b.t >= from && b.t <= to);
    if (bars.length > 0) {
      if (LAST_GOOD.size >= MAX_KEYS) {
        LAST_GOOD.delete(LAST_GOOD.keys().next().value as string);
      }
      LAST_GOOD.set(key, { at: Date.now(), bars });
    }
  } catch {
    // Keep the previous copy; the next caller still gets something real.
  }
}

/** Most recent cached bars for a window, ignoring its minute-bucket label. */
function newestFor(symbol: string, resolution: string, span: number) {
  const prefix = `${symbol}|${resolution}|`;
  const suffix = `|${span}`;
  let best: { at: number; bars: Candle[] } | null = null;
  for (const [k, v] of LAST_GOOD) {
    if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue;
    if (!best || v.at > best.at) best = v;
  }
  return best;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const symbol = q.get("symbol") ?? "";
  const resolution = q.get("resolution") ?? "";
  const from = Math.floor(Number(q.get("from")));
  const to = Math.floor(Number(q.get("to")));
  const bucket = SECONDS[resolution];

  if (
    !SYMBOL.test(symbol) ||
    bucket === undefined ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < 0 ||
    to <= from
  ) {
    return NextResponse.json({ s: "error", errmsg: "bad request" }, { status: 400 });
  }

  const span = to - from;
  const key = `${symbol}|${resolution}|${Math.floor(to / 60)}|${span}`;
  const proKey = process.env.PYTH_PRO_API_KEY;

  /* Serve the last good copy immediately and refresh behind it.
     A cold 5-second window is 719 bars from upstream and measured at ~3s; the
     first visitor was paying that in full while looking at an empty chart. The
     in-memory copy is at most one revalidate interval old, which for a
     five-second chart is five seconds — far better than three blank seconds.
     Only the very first request after a cold start still waits. */
  /* Match on symbol+resolution+span, not on the exact key.
     The key carries a minute-quantised `to`, so it rolls over every sixty
     seconds — and on every rollover the next visitor paid the full cold fetch
     again. The window they want is the same window; only its label moved. */
  const warm = newestFor(symbol, resolution, span);
  /* Answer from memory whenever there is anything recent at all, and refresh
     behind it. A tight freshness window defeated the point: it missed on
     almost every request and put a ~900ms upstream fetch back on the critical
     path of a chart that repaints every five seconds. Because a refresh is
     kicked on every request, the copy served is at most one poll old — and the
     client is polling at the bucket size anyway, so it converges immediately.
     Sixty seconds is the outer bound before we would rather wait than lie. */
  if (warm && Date.now() - warm.at < 60_000) {
    void refresh(symbol, resolution, from, to, bucket, span, key, proKey);
    return NextResponse.json(toUdf(warm.bars), {
      headers: {
        "cache-control": "public, max-age=5, stale-while-revalidate=60",
        "x-silentedge-source": "memory",
      },
    });
  }

  try {
    let bars = proKey
      ? await fromPro(symbol, resolution, from, to, proKey).catch(() =>
          fromPublic(symbol, bucket, span)
        )
      : await fromPublic(symbol, bucket, span);

    // Clip to the window actually asked for. The public windows are fixed
    // sizes, so a short request would otherwise be answered with more history
    // than the caller sized its chart for.
    bars = bars.filter((b) => b.t >= from && b.t <= to);

    if (bars.length > 0) {
      if (LAST_GOOD.size >= MAX_KEYS) {
        LAST_GOOD.delete(LAST_GOOD.keys().next().value as string);
      }
      LAST_GOOD.set(key, { at: Date.now(), bars });
    }
    return NextResponse.json(toUdf(bars), {
      headers: {
        "cache-control": "public, max-age=15, stale-while-revalidate=60",
        "x-silentedge-source": proKey ? "pro" : "public",
      },
    });
  } catch {
    const stale = LAST_GOOD.get(key);
    if (stale && Date.now() - stale.at < STALE_MS) {
      return NextResponse.json(toUdf(stale.bars), {
        headers: { "x-silentedge-stale": "1" },
      });
    }
    return NextResponse.json(
      { s: "error", errmsg: "upstream unavailable" },
      { status: 502 }
    );
  }
}
