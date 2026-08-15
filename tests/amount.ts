/**
 * Amount parsing. Pure logic, no validator needed.
 *
 * This sits on the money path: every deposit and withdrawal amount goes through
 * it, so the cases that matter are the lossy ones (0.1 at 6 decimals) and the
 * ones that must be refused rather than silently rounded.
 */

import { expect } from "chai";
import { toBaseUnits, fromBaseUnits } from "@silentedge/config";

const USDC = 6;
const SOL = 9;

describe("toBaseUnits", () => {
  it("converts whole and fractional amounts exactly", () => {
    expect(toBaseUnits("1", USDC)).to.equal(1_000_000n);
    expect(toBaseUnits("1.5", USDC)).to.equal(1_500_000n);
    expect(toBaseUnits("0.000001", USDC)).to.equal(1n);
    expect(toBaseUnits("1234.56", USDC)).to.equal(1_234_560_000n);
    expect(toBaseUnits("2.5", SOL)).to.equal(2_500_000_000n);
  });

  /** `0.1 * 1e6` is 100000.00000000001 in float. This is the reason for bigint. */
  it("is exact where floating point is not", () => {
    expect(toBaseUnits("0.1", USDC)).to.equal(100_000n);
    expect(toBaseUnits("0.3", USDC)).to.equal(300_000n);
    expect(toBaseUnits("0.07", SOL)).to.equal(70_000_000n);
    expect(toBaseUnits("8.1", SOL)).to.equal(8_100_000_000n);
  });

  it("keeps precision on amounts too large for a float to hold exactly", () => {
    // Above Number.MAX_SAFE_INTEGER once scaled — must not lose the tail.
    expect(toBaseUnits("90071992547.409911", USDC)).to.equal(
      90_071_992_547_409_911n
    );
  });

  it("handles leading zeros and a bare leading dot", () => {
    expect(toBaseUnits("007.5", USDC)).to.equal(7_500_000n);
    expect(toBaseUnits(".5", USDC)).to.equal(500_000n);
    expect(toBaseUnits("  1.25  ", USDC)).to.equal(1_250_000n);
  });

  /**
   * Refusing is the point. Truncating "1.0000001" to 1 USDC would silently
   * spend a different amount than the one the user typed.
   */
  it("refuses more precision than the mint has", () => {
    expect(toBaseUnits("1.0000001", USDC)).to.equal(null);
    expect(toBaseUnits("0.0000000001", SOL)).to.equal(null);
  });

  it("refuses zero, empty, and malformed input", () => {
    for (const bad of ["", " ", ".", "0", "0.00", "abc", "1.2.3", "-1", "1e6", "1,5"]) {
      expect(toBaseUnits(bad, USDC), `"${bad}" should be rejected`).to.equal(null);
    }
  });
});

describe("fromBaseUnits", () => {
  it("round-trips display amounts", () => {
    expect(fromBaseUnits(1_000_000n, USDC)).to.equal(1);
    expect(fromBaseUnits(2_500_000_000n, SOL)).to.equal(2.5);
    expect(fromBaseUnits(1n, USDC)).to.equal(0.000001);
  });
});
