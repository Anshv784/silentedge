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
 * Same publisher, different transport and no on-chain attestation on the second
 * one. It is fine for drawing a line and unfit for deciding a trade, so it is
 * fetched here, in the browser, and never handed to anything that signs.
 */

const BENCHMARKS = "https://benchmarks.pyth.network/v1/shims/tradingview/history";

/** V1 trades exactly one pair. Listing more would imply support that is absent. */
export const PAIRS = [
  { id: "Crypto.SOL/USD", label: "SOL / USD", tradable: true },
] as const;

export type Candle = { t: number; o: number; h: number; l: number; c: number };

export type Resolution = "60" | "240" | "D";

export const RANGES: { label: string; days: number; resolution: Resolution }[] = [
  { label: "24h", days: 1, resolution: "60" },
  { label: "7d", days: 7, resolution: "60" },
  { label: "30d", days: 30, resolution: "240" },
  { label: "1y", days: 365, resolution: "D" },
];

export async function fetchHistory(
  symbol: string,
  days: number,
  resolution: Resolution
): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const url =
    `${BENCHMARKS}?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${resolution}&from=${from}&to=${to}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`history unavailable (${r.status})`);
  const j = await r.json();
  if (j.s !== "ok" || !Array.isArray(j.t)) return [];
  return j.t.map((t: number, i: number) => ({
    t,
    o: j.o[i],
    h: j.h[i],
    l: j.l[i],
    c: j.c[i],
  }));
}

/**
 * Indicators, all derived here from the display series.
 *
 * Labelled as derived in the UI because the distinction matters: none of these
 * are inputs the program can see, and none are things the strategy can act on.
 * The circuit compares a price to fixed thresholds — it has no moving average
 * and no volatility term — so presenting an indicator next to a strategy must
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

/** A polyline path for an inline SVG chart — no charting dependency. */
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
