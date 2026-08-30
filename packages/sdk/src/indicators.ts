/**
 * Technical indicators, computed in the browser from the display series.
 *
 * Two things to be straight about, both of which a chart like this usually
 * leaves implied:
 *
 *   1. None of these can influence a trade. The Arcis circuit compares one
 *      price to three fixed thresholds. It has no moving average, no
 *      oscillator and no memory of previous candles, so nothing on this page
 *      can be "used by the strategy" no matter how it is displayed. Where the
 *      UI shows a reading next to a strategy, it says so.
 *
 *   2. A reading is not a forecast. `analyze` below reports which side of a
 *      line the price sits on, which is a description of the past. It is
 *      labelled as a mechanical reading everywhere it is rendered, and the
 *      aggregate is a count of those readings, not a recommendation.
 *
 * Everything here is pure and aligned to the input length: element `i` of a
 * returned array corresponds to candle `i`, and is `null` wherever the
 * indicator has not warmed up yet. That alignment is what lets the chart and
 * the readout agree without either of them re-deriving an offset.
 *
 * Covered by tests/indicators.ts, which checks the warm-up boundaries and the
 * two textbook cases (all-up gives RSI 100, a flat series gives RSI 50).
 */

export type Series = (number | null)[];

const nulls = (n: number): Series => new Array(n).fill(null);

/* --------------------------------------------------------------- averages */

export function sma(values: number[], period: number): Series {
  if (period <= 0 || values.length < period) return nulls(values.length);
  const out = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the simple average of the first
 * `period` values — the conventional seed, and the one that makes EMA and SMA
 * agree at the warm-up boundary instead of starting from an arbitrary point.
 */
export function ema(values: number[], period: number): Series {
  if (period <= 0 || values.length < period) return nulls(values.length);
  const out = nulls(values.length);
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/* -------------------------------------------------------------- envelopes */

export type Bollinger = { upper: Series; middle: Series; lower: Series };

/** Bollinger bands, population standard deviation over the same window. */
export function bollinger(
  values: number[],
  period = 20,
  mult = 2
): Bollinger {
  const middle = sma(values, period);
  const upper = nulls(values.length);
  const lower = nulls(values.length);
  for (let i = period - 1; i < values.length; i++) {
    const mid = middle[i];
    if (mid === null) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mid) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = mid + mult * sd;
    lower[i] = mid - mult * sd;
  }
  return { upper, middle, lower };
}

/* ------------------------------------------------------------ oscillators */

/**
 * Relative strength index, Wilder's smoothing.
 *
 * The first value is a simple average of the first `period` changes; every
 * later value smooths with weight 1/period. Using a plain moving average
 * throughout — a common shortcut — gives a visibly different line, so the
 * distinction is kept.
 *
 * A window with no losses has no defined ratio; Wilder's convention is 100,
 * and the mirror case (no gains) is 0. A window with *neither* — a price that
 * has not moved at all — is 0/0, and the answer there is 50: no directional
 * pressure in either direction. Returning 100 for it, which the usual
 * `avgLoss === 0 ? 100` shortcut does, makes a dead pair or a stablecoin read
 * as "in the upper band", and `analyze` turns that into a down verdict drawn
 * from no movement whatsoever.
 */
export function rsi(values: number[], period = 14): Series {
  if (values.length <= period) return nulls(values.length);
  const out = nulls(values.length);

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  const level = (g: number, l: number): number => {
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  };

  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = level(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = level(avgGain, avgLoss);
  }
  return out;
}

export type Macd = { macd: Series; signal: Series; histogram: Series };

/** MACD line, its signal line, and the histogram between them. */
export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  smoothing = 9
): Macd {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line: Series = values.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null
      ? (fastEma[i] as number) - (slowEma[i] as number)
      : null
  );

  // The signal is an EMA of the MACD line, which itself only exists from
  // `slow - 1` onward. Smoothing the null-padded array would treat the pad as
  // data, so the defined stretch is extracted, smoothed, and put back.
  const start = line.findIndex((v) => v !== null);
  const signal = nulls(values.length);
  if (start >= 0) {
    const defined = line.slice(start) as number[];
    const sig = ema(defined, smoothing);
    for (let i = 0; i < sig.length; i++) signal[start + i] = sig[i];
  }

  const histogram: Series = values.map((_, i) =>
    line[i] !== null && signal[i] !== null
      ? (line[i] as number) - (signal[i] as number)
      : null
  );
  return { macd: line, signal, histogram };
}

export type OHLC = { o: number; h: number; l: number; c: number };

/** Average true range, Wilder's smoothing. A volatility scale, not a signal. */
export function atr(bars: OHLC[], period = 14): Series {
  if (bars.length <= period) return nulls(bars.length);
  const tr: number[] = [bars[0].h - bars[0].l];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    tr.push(
      Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - prev),
        Math.abs(bars[i].l - prev)
      )
    );
  }
  const out = nulls(bars.length);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += tr[i];
  let prev = acc / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export type Stochastic = { k: Series; d: Series };

/** Stochastic oscillator: where the close sits inside its recent range. */
export function stochastic(
  bars: OHLC[],
  period = 14,
  smoothing = 3
): Stochastic {
  const k = nulls(bars.length);
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].h > hi) hi = bars[j].h;
      if (bars[j].l < lo) lo = bars[j].l;
    }
    // A range of zero means every bar in the window printed the same price.
    // Fifty is the honest answer: the close is neither high nor low in it.
    k[i] = hi === lo ? 50 : ((bars[i].c - lo) / (hi - lo)) * 100;
  }
  const start = k.findIndex((v) => v !== null);
  const d = nulls(bars.length);
  if (start >= 0) {
    const smoothed = sma(k.slice(start) as number[], smoothing);
    for (let i = 0; i < smoothed.length; i++) d[start + i] = smoothed[i];
  }
  return { k, d };
}

/* ---------------------------------------------------------------- levels */

/**
 * Swing highs and lows: bars whose high (or low) is the most extreme within
 * `lookback` bars either side. Clustered levels are merged so the chart does
 * not draw six lines through the same shelf.
 */
export function levels(
  bars: OHLC[],
  lookback = 8,
  maxEach = 3
): { support: number[]; resistance: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push(bars[i].h);
    if (isLow) lows.push(bars[i].l);
  }

  const last = bars.length > 0 ? bars[bars.length - 1].c : 0;
  const merge = (xs: number[]) => {
    const out: number[] = [];
    for (const x of xs.sort((a, b) => Math.abs(a - last) - Math.abs(b - last))) {
      // Within half a percent of one already kept is the same shelf.
      if (out.some((y) => Math.abs(x - y) / (y || 1) < 0.005)) continue;
      out.push(x);
      if (out.length >= maxEach) break;
    }
    return out.sort((a, b) => a - b);
  };

  return {
    support: merge(lows.filter((l) => l < last)),
    resistance: merge(highs.filter((h) => h > last)),
  };
}

/* --------------------------------------------------------------- analysis */

export type Verdict = "up" | "flat" | "down";

export type Reading = {
  name: string;
  value: string;
  verdict: Verdict;
  /** What the reading literally means, in one clause. No advice. */
  note: string;
};

export type Analysis = {
  readings: Reading[];
  up: number;
  down: number;
  flat: number;
  /** Plain summary of the tally. Deliberately not a recommendation. */
  summary: string;
  atr: number | null;
  atrPct: number | null;
  support: number[];
  resistance: number[];
};

/**
 * How many decimals a price needs to stay readable.
 *
 * BONK trades near $0.00000268 and BTC near $75,000. A fixed precision renders
 * one of them as "0.000000" and the other as noise, and a moving average shown
 * as "0.000003" is not a number anyone can compare a price to. Derived from the
 * magnitude so every pair reads correctly without a per-pair table that would
 * go stale the moment Pyth lists something new.
 *
 * Shared with the UI's price formatter so the axis, the readout and the
 * indicator panel never disagree about how precise a number is.
 */
export function decimalsFor(n: number): number {
  const a = Math.abs(n);
  if (!Number.isFinite(a) || a === 0) return 2;
  if (a >= 1_000) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  if (a >= 0.0001) return 6;
  if (a >= 0.000001) return 8;
  return 10;
}

const last = (s: Series): number | null => {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] !== null) return s[i];
  return null;
};

const fmt = (n: number, dp = 2) => n.toFixed(dp);

/**
 * How close counts as equal.
 *
 * A perfectly straight series produces a MACD histogram of -1.8e-15 rather
 * than 0, and reporting that as "MACD below its signal" is a direction
 * invented by floating point. Scaled to the price so it means the same thing
 * for BTC and for BONK.
 */
const EPS = (price: number) => Math.max(Math.abs(price) * 1e-9, Number.EPSILON);

/**
 * A mechanical read of where the price sits relative to each indicator.
 *
 * Every verdict is a comparison that already happened — "the close is above
 * the 50-period average" — never a prediction. The tally at the end counts
 * those comparisons and says so; a count of agreeing descriptions is not a
 * signal, and the UI does not render it as one.
 */
export function analyze(bars: OHLC[]): Analysis | null {
  if (bars.length < 30) return null;
  const closes = bars.map((b) => b.c);
  const price = closes[closes.length - 1];
  const readings: Reading[] = [];

  const cross = (
    name: string,
    value: number | null,
    note: string,
    dp = 2
  ): void => {
    if (value === null) return;
    const gap = price - value;
    readings.push({
      name,
      value: fmt(value, dp),
      verdict:
        Math.abs(gap) <= EPS(price) ? "flat" : gap > 0 ? "up" : "down",
      note,
    });
  };

  const dp = decimalsFor(price);
  cross("SMA 20", last(sma(closes, 20)), "close vs 20-period simple average", dp);
  cross("SMA 50", last(sma(closes, 50)), "close vs 50-period simple average", dp);
  cross("EMA 21", last(ema(closes, 21)), "close vs 21-period exponential average", dp);
  cross("EMA 99", last(ema(closes, 99)), "close vs 99-period exponential average", dp);

  const r = last(rsi(closes, 14));
  if (r !== null) {
    readings.push({
      name: "RSI 14",
      value: fmt(r, 1),
      // Above 70 and below 30 are the conventional bands. Naming them
      // "overbought"/"oversold" would smuggle in a prediction, so the note
      // describes the band and nothing else.
      verdict: r > 70 ? "down" : r < 30 ? "up" : "flat",
      note:
        r > 70
          ? "in the upper band (>70)"
          : r < 30
            ? "in the lower band (<30)"
            : "between the bands",
    });
  }

  const m = macd(closes);
  const hist = last(m.histogram);
  if (hist !== null) {
    const flatHist = Math.abs(hist) <= EPS(price);
    readings.push({
      name: "MACD",
      // Rendered as exactly zero when it is level. `(-1.8e-15).toFixed(8)` is
      // "-0.00000000", and a minus sign in front of a wall of zeros reads as
      // "slightly negative" rather than as "no gap".
      value: fmt(flatHist ? 0 : hist, dp),
      verdict: flatHist ? "flat" : hist > 0 ? "up" : "down",
      note: flatHist
        ? "MACD level with its signal"
        : hist > 0
          ? "MACD above its signal"
          : "MACD below its signal",
    });
  }

  const st = stochastic(bars);
  const k = last(st.k);
  if (k !== null) {
    readings.push({
      name: "Stoch %K",
      value: fmt(k, 1),
      verdict: k > 80 ? "down" : k < 20 ? "up" : "flat",
      note:
        k > 80
          ? "close near the top of its range"
          : k < 20
            ? "close near the bottom of its range"
            : "close mid-range",
    });
  }

  const bb = bollinger(closes);
  const upper = last(bb.upper);
  const lower = last(bb.lower);
  if (upper !== null && lower !== null) {
    readings.push({
      name: "Bollinger",
      value: `${fmt(lower, dp)} – ${fmt(upper, dp)}`,
      verdict: price > upper ? "down" : price < lower ? "up" : "flat",
      note:
        price > upper
          ? "close above the upper band"
          : price < lower
            ? "close below the lower band"
            : "close inside the bands",
    });
  }

  const a = last(atr(bars, 14));
  const up = readings.filter((x) => x.verdict === "up").length;
  const down = readings.filter((x) => x.verdict === "down").length;
  const flat = readings.length - up - down;

  const lv = levels(bars);
  return {
    readings,
    up,
    down,
    flat,
    summary:
      up === down
        ? `${up} readings each way, ${flat} neutral — no consistent picture.`
        : `${Math.max(up, down)} of ${readings.length} readings point ${
            up > down ? "up" : "down"
          }, ${flat} neutral.`,
    atr: a,
    atrPct: a !== null && price > 0 ? (a / price) * 100 : null,
    support: lv.support,
    resistance: lv.resistance,
  };
}
