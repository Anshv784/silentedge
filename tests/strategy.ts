/**
 * Strategy validation and normalization. Pure logic, no validator needed.
 *
 * Normalization is the last point where a mistake is cheap. After this the
 * values get encrypted, go on chain, and start deciding trades — at which point
 * a wrong number is only visible as money leaving.
 */

import { expect } from "chai";
import {
  Strategy,
  normalize,
  validateStrategy,
  toPriceUnits,
  describeRule,
  NEVER_BUY,
  NEVER_SELL,
  NO_STOP,
} from "@silentedge/types";

const MAX_SIZE_BPS = 1_000; // the vault's maxTradeBps

const draft = (over: Partial<Strategy> = {}): Strategy => ({
  name: "Range",
  rules: [
    { kind: "entry", value: "150" },
    { kind: "exit", value: "180" },
  ],
  sizeBps: 500,
  ...over,
});

const fieldsWithErrors = (s: Strategy, cap: number = MAX_SIZE_BPS) =>
  validateStrategy(s, cap).map((e) => e.field);

describe("toPriceUnits", () => {
  it("scales prices exactly", () => {
    expect(toPriceUnits("150")).to.equal(150_000_000n);
    expect(toPriceUnits("150.25")).to.equal(150_250_000n);
    expect(toPriceUnits("0.1")).to.equal(100_000n);
  });

  it("refuses zero, over-precision, and malformed prices", () => {
    for (const bad of ["", "0", "0.0", "abc", "-5", "1e3", "1.2.3", "1.0000001"]) {
      expect(toPriceUnits(bad), `"${bad}"`).to.equal(null);
    }
  });
});

describe("validateStrategy", () => {
  it("accepts a well-formed draft", () => {
    expect(validateStrategy(draft(), MAX_SIZE_BPS)).to.deep.equal([]);
  });

  it("requires a name and at least one rule", () => {
    expect(fieldsWithErrors(draft({ name: "  " }))).to.include("name");
    expect(fieldsWithErrors(draft({ rules: [] }))).to.include("rules");
  });

  it("rejects a name longer than the limit", () => {
    expect(fieldsWithErrors(draft({ name: "x".repeat(41) }))).to.include("name");
  });

  it("rejects duplicate rules of the same kind", () => {
    const s = draft({
      rules: [
        { kind: "entry", value: "150" },
        { kind: "entry", value: "160" },
      ],
    });
    expect(fieldsWithErrors(s)).to.include("entry");
  });

  /**
   * A sell below the buy round-trips on every evaluation, paying spread and
   * fees each time. It looks like a working bot while bleeding.
   */
  it("rejects a sell price at or below the buy price", () => {
    expect(
      fieldsWithErrors(
        draft({ rules: [
          { kind: "entry", value: "150" },
          { kind: "exit", value: "140" },
        ] })
      )
    ).to.include("exit");

    expect(
      fieldsWithErrors(
        draft({ rules: [
          { kind: "entry", value: "150" },
          { kind: "exit", value: "150" },
        ] })
      )
    ).to.include("exit");
  });

  /** A stop at or above the entry fires the moment it buys. */
  it("rejects a stop at or above the buy price", () => {
    for (const stop of ["150", "160"]) {
      expect(
        fieldsWithErrors(
          draft({ rules: [
            { kind: "entry", value: "150" },
            { kind: "stop", value: stop },
          ] })
        ),
        `stop ${stop}`
      ).to.include("stop");
    }
  });

  it("accepts a stop below the buy price", () => {
    const s = draft({
      rules: [
        { kind: "entry", value: "150" },
        { kind: "exit", value: "180" },
        { kind: "stop", value: "120" },
      ],
    });
    expect(validateStrategy(s, MAX_SIZE_BPS)).to.deep.equal([]);
  });

  it("holds trade size within the vault's own cap", () => {
    expect(fieldsWithErrors(draft({ sizeBps: 0 }))).to.include("sizeBps");
    expect(fieldsWithErrors(draft({ sizeBps: 1_001 }))).to.include("sizeBps");
    expect(fieldsWithErrors(draft({ sizeBps: 1_000 }))).to.deep.equal([]);
  });
});

describe("normalize", () => {
  it("collapses rules into the circuit fields, in field order", () => {
    const s = draft({
      rules: [
        { kind: "entry", value: "150" },
        { kind: "exit", value: "180.5" },
        { kind: "stop", value: "120" },
      ],
      sizeBps: 250,
    });
    expect(normalize(s, MAX_SIZE_BPS)).to.deep.equal({
      entryBelow: 150_000_000n,
      exitAbove: 180_500_000n,
      stopBelow: 120_000_000n,
      sizeBps: 250,
    });
  });

  /**
   * A rule the user left off must still occupy its slot, with a value whose
   * comparison is never true. In MPC both branches run either way, so "off"
   * has to be unobservable rather than skipped.
   */
  it("fills omitted rules with never-true sentinels", () => {
    const buyOnly = normalize(
      draft({ rules: [{ kind: "entry", value: "150" }] }),
      MAX_SIZE_BPS
    );
    expect(buyOnly.exitAbove).to.equal(NEVER_SELL);
    expect(buyOnly.stopBelow).to.equal(NO_STOP);

    const sellOnly = normalize(
      draft({ rules: [{ kind: "exit", value: "180" }] }),
      MAX_SIZE_BPS
    );
    expect(sellOnly.entryBelow).to.equal(NEVER_BUY);
  });

  /**
   * Boundaries, each checked on both sides. These are the values a user is most
   * likely to enter by accident and the ones a validator is most likely to get
   * wrong by one.
   */
  it("accepts and rejects exactly at each boundary", () => {
    // Price precision: PRICE_DECIMALS is the limit, not a suggestion.
    expect(fieldsWithErrors(draft({ rules: [{ kind: "entry", value: "150.123456" }] })))
      .to.deep.equal([]);
    expect(fieldsWithErrors(draft({ rules: [{ kind: "entry", value: "150.1234567" }] })))
      .to.include("entry");

    // Ordering is strict: equal is not ordered.
    const at = (exit: string) =>
      fieldsWithErrors(draft({
        rules: [{ kind: "entry", value: "150" }, { kind: "exit", value: exit }],
      }));
    expect(at("150"), "exit equal to entry").to.include("exit");
    expect(at("150.000001"), "exit one unit above entry").to.deep.equal([]);

    const stopAt = (stop: string) =>
      fieldsWithErrors(draft({
        rules: [{ kind: "entry", value: "150" }, { kind: "stop", value: stop }],
      }));
    expect(stopAt("150"), "stop equal to entry").to.include("stop");
    expect(stopAt("149.999999"), "stop one unit below entry").to.deep.equal([]);

    // Name length.
    expect(fieldsWithErrors(draft({ name: "x".repeat(40) }))).to.deep.equal([]);
    expect(fieldsWithErrors(draft({ name: "x".repeat(41) }))).to.include("name");
  });

  /**
   * The builder's cap is the vault's own `max_trade_bps`, which varies per
   * vault. A validator that assumed a constant would either refuse a size the
   * program accepts or accept one it rejects — the second only discovered after
   * an MPC evaluation had been paid for.
   */
  it("takes the size cap from the vault rather than a constant", () => {
    expect(fieldsWithErrors(draft({ sizeBps: 2_000 }), 2_000)).to.deep.equal([]);
    expect(fieldsWithErrors(draft({ sizeBps: 2_001 }), 2_000)).to.include("sizeBps");
    expect(fieldsWithErrors(draft({ sizeBps: 2_000 }), 1_000)).to.include("sizeBps");
  });

  it("keeps sentinels inside u64", () => {
    expect(NEVER_SELL).to.equal(2n ** 64n - 1n);
    expect(NEVER_BUY).to.equal(0n);
  });

  it("refuses to normalize an invalid draft", () => {
    expect(() => normalize(draft({ name: "" }), MAX_SIZE_BPS)).to.throw(
      /Cannot normalize/
    );
    expect(() =>
      normalize(
        draft({ rules: [
          { kind: "entry", value: "150" },
          { kind: "exit", value: "100" },
        ] }),
        MAX_SIZE_BPS
      )
    ).to.throw(/Cannot normalize/);
  });
});

describe("describeRule", () => {
  it("renders rules the way they are evaluated", () => {
    expect(describeRule({ kind: "entry", value: "150" })).to.equal(
      "PRICE < 150 → BUY"
    );
    expect(describeRule({ kind: "exit", value: "180" })).to.equal(
      "PRICE > 180 → SELL"
    );
    expect(describeRule({ kind: "stop", value: "120" })).to.equal(
      "PRICE < 120 → SELL ALL"
    );
  });
});
