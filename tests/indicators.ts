/**
 * Indicators, checked at the places they are actually wrong when they are wrong.
 *
 * These numbers are display-only — no instruction in the program can read
 * them — but a chart that draws a confidently wrong RSI is worse than one that
 * draws nothing, because a user tunes thresholds against what they see. So the
 * checks here are the ones that catch a real implementation slip rather than
 * restating the code:
 *
 *   - warm-up boundaries, because an off-by-one there silently shifts every
 *     plotted point one candle into the future,
 *   - the RSI cases with known answers, including the zero-movement case that
 *     the conventional shortcut gets wrong,
 *   - Wilder's smoothing actually being Wilder's rather than a plain average,
 *   - the degenerate inputs (flat series, zero range) that produce NaN or
 *     Infinity if the guards are removed.
 */
import { expect } from "chai";
import {
  analyze,
  atr,
  decimalsFor,
  bollinger,
  ema,
  levels,
  macd,
  rsi,
  sma,
  stochastic,
  type OHLC,
} from "@silentedge/sdk";

/** A candle from a close, with a small symmetric range around it. */
const bar = (c: number, spread = 1): OHLC => ({
  o: c,
  h: c + spread,
  l: c - spread,
  c,
});

const rising = (n: number, from = 100, step = 1) =>
  Array.from({ length: n }, (_, i) => from + i * step);

const flat = (n: number, at = 100) => new Array(n).fill(at);

describe("indicators — moving averages", () => {
  it("returns nothing until the window is full", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).to.deep.equal([null, null]);
    expect(out[2]).to.equal(2); // (1+2+3)/3
    expect(out[4]).to.equal(4); // (3+4+5)/3
  });

  it("is all null when there is less data than the period", () => {
    expect(sma([1, 2], 5)).to.deep.equal([null, null]);
    expect(ema([1, 2], 5)).to.deep.equal([null, null]);
  });

  it("seeds the EMA with the simple average, so both agree at the boundary", () => {
    const values = [10, 20, 30, 40, 50];
    const s = sma(values, 3);
    const e = ema(values, 3);
    expect(e[2]).to.equal(s[2]);
    // k = 2/(3+1) = 0.5, so the next point is halfway between seed and price.
    expect(e[3]).to.equal(0.5 * 40 + 0.5 * 20);
  });

  it("never emits NaN on a flat series", () => {
    for (const v of [...sma(flat(40), 20), ...ema(flat(40), 21)]) {
      if (v !== null) expect(Number.isFinite(v)).to.equal(true);
    }
  });
});

describe("indicators — RSI", () => {
  it("is 100 when nothing has fallen", () => {
    const out = rsi(rising(40), 14);
    expect(out[13]).to.equal(null, "not warmed up until index 14");
    expect(out[14]).to.equal(100);
    expect(out[39]).to.equal(100);
  });

  it("is 0 when nothing has risen", () => {
    const out = rsi(rising(40, 100, -1), 14);
    expect(out[out.length - 1]).to.equal(0);
  });

  it("is 50 when gains and losses are equal", () => {
    // Alternating +1/-1 gives seven gains and seven losses in the seed window.
    const values = Array.from({ length: 60 }, (_, i) => 100 + (i % 2));
    const out = rsi(values, 14);
    expect(out[14]).to.be.closeTo(50, 1e-9);
    // Later points sit either side of 50 depending on which way the most
    // recent candle went, which is Wilder's smoothing working, not drift.
    expect(out[out.length - 1]).to.be.closeTo(50, 3);
  });

  it("is 50, not 100, when the price has not moved at all", () => {
    // The usual `avgLoss === 0 ? 100` shortcut reports a dead pair as being in
    // the upper band, and `analyze` turns that into a down verdict drawn from
    // no movement whatsoever. Delete the zero-gain guard and this fails.
    const out = rsi(flat(40), 14);
    expect(out[14]).to.equal(50);
    expect(out[39]).to.equal(50);
  });

  it("uses Wilder's smoothing rather than a plain moving average", () => {
    // One big jump, then thirty bars of even chop. A plain 14-period average
    // has dropped the jump out of its window entirely by the end and reports
    // the chop alone — seven gains against seven losses, RSI 50. Wilder's
    // decays the jump by (13/14)^30 and still carries about a tenth of it, so
    // the reading stays clearly above 50. Swap the smoothing for a rolling
    // mean and this lands on 50 and fails.
    const values = [
      ...flat(20, 100),
      130,
      ...Array.from({ length: 30 }, (_, i) => 130 + (i % 2) * 0.5),
    ];
    const out = rsi(values, 14);
    const tail = out[out.length - 1] as number;
    expect(tail).to.be.greaterThan(55);
    expect(tail).to.be.lessThan(100);
  });

  it("is all null when there is not enough data", () => {
    expect(rsi([1, 2, 3], 14).every((v) => v === null)).to.equal(true);
  });
});

describe("indicators — MACD", () => {
  it("aligns the signal to the MACD line, not to the padded array", () => {
    const { macd: line, signal, histogram } = macd(rising(80));
    // The line exists from slow-1 = 25; the signal needs 9 more of those.
    expect(line[24]).to.equal(null);
    expect(line[25]).to.not.equal(null);
    expect(signal[32]).to.equal(null);
    expect(signal[33]).to.not.equal(null);
    // Smoothing the null pad as if it were zeros would make the signal appear
    // at index 25 and drag it toward zero. This is the check that catches it.
    expect(histogram[32]).to.equal(null);
    expect(histogram[33]).to.not.equal(null);
  });

  it("puts the fast average above the slow one while the series rises", () => {
    const { macd: line } = macd(rising(120));
    expect(line[119] as number).to.be.greaterThan(0);
  });

  it("leaves the histogram at zero on a straight line, and positive on a curve", () => {
    // A constant slope gives a constant MACD, so there is nothing for the
    // signal to lag behind. Acceleration is what opens the histogram.
    const straight = macd(rising(160));
    expect(straight.histogram[159] as number).to.be.closeTo(0, 1e-9);

    const curved = macd(Array.from({ length: 160 }, (_, i) => 100 + i * i * 0.01));
    expect(curved.histogram[159] as number).to.be.greaterThan(0);
  });

  it("collapses to zero on a flat series", () => {
    const { macd: line, histogram } = macd(flat(120));
    expect(line[119] as number).to.be.closeTo(0, 1e-9);
    expect(histogram[119] as number).to.be.closeTo(0, 1e-9);
  });
});

describe("indicators — bands and range", () => {
  it("collapses the Bollinger bands onto the mean when price does not move", () => {
    const { upper, middle, lower } = bollinger(flat(40), 20, 2);
    expect(middle[39]).to.equal(100);
    expect(upper[39]).to.equal(100);
    expect(lower[39]).to.equal(100);
  });

  it("keeps the bands symmetric about the middle", () => {
    const values = rising(60).map((v, i) => v + (i % 3) * 2);
    const { upper, middle, lower } = bollinger(values, 20, 2);
    const i = values.length - 1;
    expect((upper[i] as number) - (middle[i] as number)).to.be.closeTo(
      (middle[i] as number) - (lower[i] as number),
      1e-9
    );
  });

  it("returns 50 rather than NaN when a stochastic window has zero range", () => {
    const bars = flat(30).map((c) => bar(c, 0));
    const { k, d } = stochastic(bars, 14, 3);
    expect(k[29]).to.equal(50);
    expect(Number.isFinite(d[29] as number)).to.equal(true);
  });

  it("reads 100 at the top of the range and 0 at the bottom", () => {
    const up = rising(30).map((c) => bar(c, 0));
    expect(up[29].c).to.equal(129);
    const { k } = stochastic(up, 14, 3);
    expect(k[29]).to.equal(100);
  });

  it("warms ATR up at period-1 and stays positive", () => {
    const bars = rising(40).map((c) => bar(c, 2));
    const out = atr(bars, 14);
    expect(out[12]).to.equal(null);
    expect(out[13]).to.not.equal(null);
    expect(out[39] as number).to.be.greaterThan(0);
  });
});

describe("indicators — levels", () => {
  it("finds a swing high above the close and a swing low below it", () => {
    // Up to a single peak, down to a trough, then partway back up. The peak
    // must not be repeated by the first bar of the descent or neither bar is
    // a strict extreme and no level is found.
    const closes = [
      ...rising(20, 100, 2), // 100 → 138
      ...rising(20, 135, -3), // 135 → 78
      ...rising(10, 81, 2), // 81 → 99
    ];
    const { support, resistance } = levels(closes.map((c) => bar(c, 0.5)), 5, 3);
    expect(resistance.some((r) => r > 99)).to.equal(true);
    expect(support.every((s) => s < 99)).to.equal(true);
  });

  it("does not draw two lines through the same shelf", () => {
    const bars = rising(80, 100, 1).map((c) => bar(c, 0.5));
    const { support, resistance } = levels(bars, 5, 3);
    for (const set of [support, resistance]) {
      for (let i = 1; i < set.length; i++) {
        expect(Math.abs(set[i] - set[i - 1]) / set[i - 1]).to.be.greaterThan(
          0.004
        );
      }
    }
  });
});

describe("indicators — price precision", () => {
  it("keeps a sub-cent price readable instead of rounding it to zero", () => {
    // BONK. Six decimals renders this as "0.000003", which is not a number a
    // trader can compare their entry to.
    expect(decimalsFor(0.00000268)).to.be.greaterThan(6);
    expect((0.00000268).toFixed(decimalsFor(0.00000268))).to.not.match(
      /^0\.0*$/
    );
  });

  it("does not drown a large price in decimals", () => {
    expect(decimalsFor(75_000)).to.equal(2);
    expect(decimalsFor(89.4)).to.equal(4);
  });

  it("survives zero and non-finite input", () => {
    for (const n of [0, NaN, Infinity, -Infinity]) {
      const d = decimalsFor(n);
      expect(Number.isInteger(d)).to.equal(true);
      expect(d).to.be.greaterThan(0);
    }
  });

  it("reports a sub-cent asset's moving averages at usable precision", () => {
    const a = analyze(
      Array.from({ length: 200 }, (_, i) => bar(0.0000025 + i * 1e-9, 1e-9))
    )!;
    // MACD is excluded: on a constant slope it is genuinely zero, and zero is
    // the right thing to print. Everything else is a price and must not
    // collapse to a row of zeros.
    for (const r of a.readings.filter((x) => x.name !== "MACD")) {
      expect(r.value, r.name).to.not.match(/^-?0\.0+$/);
    }
  });

  it("never prints a negative zero", () => {
    const a = analyze(
      Array.from({ length: 200 }, (_, i) => bar(0.0000025 + i * 1e-9, 1e-9))
    )!;
    for (const r of a.readings) {
      expect(r.value, r.name).to.not.match(/^-0\.?0*$/);
    }
  });
});

describe("indicators — analysis", () => {
  it("refuses to report on a window too short to warm up", () => {
    expect(analyze(rising(10).map((c) => bar(c)))).to.equal(null);
  });

  it("reads a sustained rise as up on the trend-following lines", () => {
    const a = analyze(rising(200, 100, 0.5).map((c) => bar(c)))!;
    expect(a).to.not.equal(null);
    const byName = Object.fromEntries(a.readings.map((r) => [r.name, r]));
    expect(byName["SMA 20"].verdict).to.equal("up");
    expect(byName["SMA 50"].verdict).to.equal("up");
    expect(byName["EMA 21"].verdict).to.equal("up");
    expect(byName["EMA 99"].verdict).to.equal("up");
  });

  it("does not invent a direction out of floating-point noise", () => {
    // A straight line leaves the MACD level with its signal to within 1e-15.
    // Without the epsilon that reads as "MACD below its signal" — a bearish
    // verdict produced by rounding on a series that only ever rose.
    const a = analyze(rising(200, 100, 0.5).map((c) => bar(c)))!;
    const m = a.readings.find((r) => r.name === "MACD")!;
    expect(m.verdict).to.equal("flat");
    expect(m.note).to.match(/level with its signal/);
  });

  it("counts the readings it actually produced", () => {
    const a = analyze(rising(200, 100, 0.5).map((c) => bar(c)))!;
    expect(a.up + a.down + a.flat).to.equal(a.readings.length);
  });

  it("reports every reading with a finite, printable value", () => {
    for (const bars of [
      rising(200, 100, 0.5).map((c) => bar(c)),
      flat(200).map((c) => bar(c, 0)),
      rising(200, 200, -0.5).map((c) => bar(c)),
    ]) {
      const a = analyze(bars)!;
      expect(a).to.not.equal(null);
      for (const r of a.readings) {
        expect(r.value).to.not.match(/NaN|Infinity/);
      }
      if (a.atrPct !== null) expect(Number.isFinite(a.atrPct)).to.equal(true);
    }
  });

  it("states a tie as a tie rather than picking a side", () => {
    const a = analyze(flat(200).map((c) => bar(c, 0)))!;
    if (a.up === a.down) {
      expect(a.summary).to.match(/no consistent picture/);
    }
  });
});
