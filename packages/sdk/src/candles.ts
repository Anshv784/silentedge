/**
 * Candle resampling.
 *
 * Pyth retired the `/v1/shims/tradingview/*` endpoints on 26 August 2026, and
 * the official replacement — the Pyth Pro History API — needs an API key that
 * its own documentation says must never reach a browser. Without that key the
 * only unauthenticated source is `web-api.pyth.network/history`, which serves
 * four fixed windows at fixed granularities rather than an arbitrary
 * timeframe. Turning those into the timeframes a trader actually picks means
 * resampling, and resampling a candle series is the kind of thing that looks
 * obviously right and is quietly wrong, so it lives here with tests rather
 * than inline in a route handler.
 */

export type Candle = { t: number; o: number; h: number; l: number; c: number };

/**
 * Group `src` into buckets of `seconds` and reduce each to one candle.
 *
 * Open is the first open in the bucket and close is the last close — not the
 * min and max, which is the tempting mistake, and not the bucket's own
 * boundary values, which would invent prices that never printed. High and low
 * are the true extremes across the whole bucket including the wicks, because a
 * stop is triggered by the low that happened and not by the low of the closes.
 *
 * Buckets are aligned to absolute epoch time rather than to the first sample,
 * so the same series requested over two different windows produces candles on
 * the same boundaries instead of two grids that disagree.
 *
 * Input need not be sorted. Empty buckets are omitted rather than carried
 * forward: a gap in the data is a gap, and filling it with the previous close
 * would draw a flat line where there was no market.
 */
export function resample(src: Candle[], seconds: number): Candle[] {
  if (seconds <= 0) throw new Error("bucket must be positive");
  if (src.length === 0) return [];

  const sorted = [...src].sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let bucket = NaN;

  for (const c of sorted) {
    if (!Number.isFinite(c.t)) continue;
    const b = Math.floor(c.t / seconds) * seconds;
    if (cur === null || b !== bucket) {
      if (cur) out.push(cur);
      bucket = b;
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c };
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}
