import { expect } from "chai";
import { resample, type Candle } from "@silentedge/sdk";

/**
 * Resampling tests.
 *
 * Every case here fails if the corresponding line of `resample` is deleted or
 * inverted. The OHLC reduction in particular has four independent rules and a
 * plausible-looking implementation can get any one of them backwards while the
 * chart still renders something candle-shaped.
 */

const c = (t: number, o: number, h: number, l: number, cl: number): Candle => ({
  t,
  o,
  h,
  l,
  c: cl,
});

describe("resample", () => {
  it("reduces a bucket to first open and last close", () => {
    const src = [
      c(0, 10, 12, 9, 11),
      c(60, 11, 15, 10, 14),
      c(120, 14, 16, 13, 13),
    ];
    const [bar] = resample(src, 300);
    expect(bar.o).to.equal(10); // first open, not the lowest
    expect(bar.c).to.equal(13); // last close, not the highest
  });

  it("takes high and low from the wicks, not from the bodies", () => {
    // The extreme prices never appear as an open or a close. A version that
    // reduced over o/c instead of h/l would return 10 and 16.
    const src = [c(0, 10, 99, 1, 11), c(60, 11, 20, 5, 16)];
    const [bar] = resample(src, 300);
    expect(bar.h).to.equal(99);
    expect(bar.l).to.equal(1);
  });

  it("aligns buckets to absolute epoch time, not to the first sample", () => {
    // First sample at t=310 belongs in the 300-second bucket starting at 300,
    // not in a bucket that starts at 310.
    const src = [c(310, 1, 1, 1, 1), c(590, 2, 2, 2, 2), c(600, 3, 3, 3, 3)];
    const out = resample(src, 300);
    expect(out.map((b) => b.t)).to.deep.equal([300, 600]);
  });

  it("splits samples into separate candles at the bucket boundary", () => {
    const src = [c(0, 1, 1, 1, 1), c(299, 2, 2, 2, 2), c(300, 3, 3, 3, 3)];
    const out = resample(src, 300);
    expect(out).to.have.length(2);
    expect(out[0].c).to.equal(2);
    expect(out[1].o).to.equal(3);
  });

  it("omits empty buckets rather than carrying the previous close forward", () => {
    // A four-hour gap. Filling it would draw a flat line across a period where
    // there was no data at all.
    const src = [c(0, 1, 1, 1, 1), c(14_400, 2, 2, 2, 2)];
    const out = resample(src, 3600);
    expect(out).to.have.length(2);
    expect(out.map((b) => b.t)).to.deep.equal([0, 14_400]);
  });

  it("sorts unordered input before bucketing", () => {
    const src = [c(120, 3, 3, 3, 3), c(0, 1, 1, 1, 1), c(60, 2, 2, 2, 2)];
    const [bar] = resample(src, 300);
    expect(bar.o).to.equal(1);
    expect(bar.c).to.equal(3);
  });

  it("passes a series through unchanged when the bucket matches its interval", () => {
    const src = [c(0, 1, 2, 0, 1), c(60, 2, 3, 1, 2)];
    expect(resample(src, 60)).to.deep.equal(src);
  });

  it("returns nothing for an empty series", () => {
    expect(resample([], 60)).to.deep.equal([]);
  });

  it("refuses a non-positive bucket rather than looping forever", () => {
    expect(() => resample([c(0, 1, 1, 1, 1)], 0)).to.throw();
  });

  it("drops samples with a non-finite timestamp", () => {
    const src = [c(0, 1, 1, 1, 1), c(NaN, 9, 9, 9, 9)];
    const out = resample(src, 300);
    expect(out).to.have.length(1);
    expect(out[0].h).to.equal(1);
  });
});
