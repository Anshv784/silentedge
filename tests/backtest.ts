/**
 * The backtest must decide what the circuit decides.
 *
 * A simulator that is subtly kinder than production is worse than no simulator:
 * the user tunes against a strategy that does not exist, then funds it. These
 * assert the decision table against `evaluate_strategy_v3` in
 * encrypted-ixs/src/lib.rs, case by case, including the cases where the two
 * could plausibly diverge — a stop and a take-profit firing together, a stop
 * exiting the whole position rather than a fraction, and selling outranking
 * buying when a price is below both the stop and the entry.
 */
import { expect } from "chai";
import {
  decideLikeCircuit,
  runBacktest,
  BT_HOLD,
  BT_BUY,
  BT_SELL,
  type BacktestStrategy,
  type PricePoint,
} from "@silentedge/sdk";

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const NEVER_SELL = 18_446_744_073_709_551_615n;
const NEVER_BUY = 0n;
const NO_STOP = 0n;

const strat = (over: Partial<BacktestStrategy> = {}): BacktestStrategy => ({
  entryBelow: usd(150),
  exitAbove: NEVER_SELL,
  stopBelow: NO_STOP,
  sizeBps: 1_000,
  ...over,
});

const QUOTE = 1_000_000n;
const BASE = 1_000_000_000n;

describe("backtest decisions match the circuit", () => {
  it("buys below the entry and holds at or above it", () => {
    const s = strat();
    expect(decideLikeCircuit(s, usd(149), 1_000n * QUOTE, 0n).action).to.equal(BT_BUY);
    expect(decideLikeCircuit(s, usd(150), 1_000n * QUOTE, 0n).action).to.equal(BT_HOLD);
    expect(decideLikeCircuit(s, usd(151), 1_000n * QUOTE, 0n).action).to.equal(BT_HOLD);
  });

  it("sells above the take-profit, strictly", () => {
    const s = strat({ entryBelow: NEVER_BUY, exitAbove: usd(180) });
    expect(decideLikeCircuit(s, usd(180), 0n, BASE).action).to.equal(BT_HOLD);
    expect(decideLikeCircuit(s, usd(181), 0n, BASE).action).to.equal(BT_SELL);
  });

  /**
   * The circuit computes `sell = stop_hit | take_profit` before considering the
   * entry, so a price under the stop is a sell even though it is also under the
   * entry. A simulator that checked the entry first would buy into a crash.
   */
  it("lets selling outrank buying when a price satisfies both", () => {
    const s = strat({ entryBelow: usd(150), stopBelow: usd(120) });
    const d = decideLikeCircuit(s, usd(119), 1_000n * QUOTE, BASE);
    expect(d.action).to.equal(BT_SELL);
    expect(d.reason).to.equal("stop");
  });

  it("exits the whole position on a stop, not a fraction", () => {
    const s = strat({ stopBelow: usd(120), sizeBps: 1_000 });
    const held = 7n * BASE;
    const d = decideLikeCircuit(s, usd(119), 0n, held);
    expect(d.amount.toString(), "a stop is a full exit").to.equal(held.toString());
  });

  it("sizes a take-profit from the base balance, an entry from the quote", () => {
    const sell = decideLikeCircuit(
      strat({ entryBelow: NEVER_BUY, exitAbove: usd(180), sizeBps: 2_500 }),
      usd(181), 0n, 8n * BASE
    );
    expect(sell.amount.toString()).to.equal((2n * BASE).toString()); // 25% of 8

    const buy = decideLikeCircuit(strat({ sizeBps: 2_500 }), usd(149), 400n * QUOTE, 0n);
    expect(buy.amount.toString()).to.equal((100n * QUOTE).toString()); // 25% of 400
  });

  it("trades nothing on a hold", () => {
    const d = decideLikeCircuit(strat(), usd(200), 1_000n * QUOTE, BASE);
    expect(d.action).to.equal(BT_HOLD);
    expect(d.amount.toString()).to.equal("0");
    expect(d.reason).to.equal(null);
  });
});

describe("backtest execution rules match execute_trade", () => {
  const hourly = (prices: number[]): PricePoint[] =>
    prices.map((price, i) => ({ t: 1_700_000_000 + i * 3_600, price }));

  const limits = { maxTradeBps: 1_000, cooldownSeconds: 0, costBps: 30 };

  it("returns nothing for an empty series rather than pretending", () => {
    expect(runBacktest([], strat(), limits, 1_000)).to.equal(null);
  });

  it("holds a flat, above-entry market and reports a flat result", () => {
    const r = runBacktest(hourly([200, 200, 200]), strat(), limits, 1_000)!;
    expect(r.trades).to.have.length(0);
    expect(r.startValue).to.equal(1_000);
    expect(r.endValue).to.equal(1_000);
    expect(r.returnPct).to.equal(0);
  });

  it("buys the configured fraction, not the whole balance", () => {
    const r = runBacktest(hourly([140, 140]), strat({ sizeBps: 1_000 }), limits, 1_000)!;
    expect(r.trades.length).to.be.greaterThan(0);
    expect(r.trades[0].amountIn).to.be.closeTo(100, 0.01); // 10% of 1,000
    expect(r.trades[0].reason).to.equal("entry");
  });

  /**
   * The cap is a property of `execute_trade`, so the simulation has to apply it
   * or it will report entries the chain would have refused.
   */
  it("refuses an entry above the per-trade cap, and says why", () => {
    const tight = { ...limits, maxTradeBps: 100 }; // 1% cap
    const r = runBacktest(hourly([140, 140]), strat({ sizeBps: 5_000 }), tight, 1_000)!;
    expect(r.trades).to.have.length(0);
    expect(r.skipped.map((s) => s.reason)).to.include("above the per-trade cap");
  });

  it("throttles entries on a cooldown but never exits", () => {
    const slow = { ...limits, cooldownSeconds: 7_200 }; // 2h, series is hourly
    const r = runBacktest(hourly([140, 139, 138, 137]), strat(), slow, 1_000)!;
    expect(r.skipped.some((s) => s.reason === "cooldown"), "expected a throttled entry")
      .to.equal(true);

    // A stop must still fire inside the same window.
    const withStop = strat({ stopBelow: usd(135) });
    const r2 = runBacktest(hourly([140, 139, 130]), withStop, slow, 1_000)!;
    expect(r2.trades.some((t) => t.reason === "stop"), "a stop must not be throttled")
      .to.equal(true);
  });

  it("counts a round trip as a win or a loss, and nothing else as either", () => {
    const s = strat({ entryBelow: usd(150), exitAbove: usd(180) });
    const r = runBacktest(hourly([140, 190, 140, 190]), s, limits, 1_000)!;
    expect(r.wins + r.losses).to.equal(
      r.trades.filter((t) => t.side === 2).length
    );
    expect(r.wins).to.be.greaterThan(0);
  });

  it("reports buy-and-hold alongside, so the strategy can be judged against it", () => {
    const r = runBacktest(hourly([100, 200]), strat({ entryBelow: NEVER_BUY }), limits, 1_000)!;
    expect(r.holdReturnPct).to.be.closeTo(100, 0.001);
    // No entry rule means no trades, so the strategy itself returns nothing.
    expect(r.returnPct).to.equal(0);
  });

  it("charges the cost model on every fill", () => {
    const free = runBacktest(hourly([140, 140]), strat(), { ...limits, costBps: 0 }, 1_000)!;
    const costly = runBacktest(hourly([140, 140]), strat(), { ...limits, costBps: 100 }, 1_000)!;
    expect(costly.trades[0].amountOut).to.be.lessThan(free.trades[0].amountOut);
  });
});
