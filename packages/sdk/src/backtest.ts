/**
 * A backtest that runs the same decision the circuit runs.
 *
 * The failure mode this file exists to avoid is a simulator that is subtly
 * kinder than production: it sells on a stop the strategy would not have taken,
 * or sizes a trade the program would have rejected, and the user tunes against
 * a strategy that does not exist. So the decision function below mirrors
 * `evaluate_strategy_v3` in encrypted-ixs/src/lib.rs statement for statement,
 * and the execution rules mirror `execute_trade`.
 *
 * Mirrored from the circuit:
 *   stop_hit    = price < stop_below
 *   take_profit = price > exit_above
 *   entry_hit   = price < entry_below
 *   sell        = stop_hit | take_profit          (selling outranks buying)
 *   amount      = stop ? whole base position
 *                      : sell ? base * size_bps/1e4
 *                      : buy  ? quote * size_bps/1e4
 *                      : 0
 *
 * Mirrored from execute_trade:
 *   entries are capped at max_trade_bps of the source balance
 *   entries are refused during the cooldown; exits are exempt from both
 *   a trade needs the source balance to cover it
 *
 * What is deliberately NOT modelled, because modelling it badly would be worse
 * than leaving it out: order-book impact, MEV, the ~72-slot gap between a
 * decision and its execution, and Jupiter's routing. A flat cost in basis
 * points stands in for spread and fees, and the result is labelled a
 * simulation everywhere it is shown.
 */

// Named with a prefix: `decide.ts` exports BT_BUY/BT_SELL for the executor
// and both are re-exported from the package root.
export const BT_HOLD = 0;
export const BT_BUY = 1;
export const BT_SELL = 2;

export type BacktestStrategy = {
  /** Fixed-point with 6 decimals, exactly as the circuit sees them. */
  entryBelow: bigint;
  exitAbove: bigint;
  stopBelow: bigint;
  sizeBps: number;
};

export type BacktestLimits = {
  maxTradeBps: number;
  cooldownSeconds: number;
  /** Flat cost per fill, standing in for spread, fees and routing. */
  costBps: number;
};

export type PricePoint = { t: number; price: number };

export type SimTrade = {
  t: number;
  side: 1 | 2;
  price: number;
  /** Input amount in the mint being spent. */
  amountIn: number;
  amountOut: number;
  reason: "entry" | "take-profit" | "stop";
};

export type BacktestResult = {
  startValue: number;
  endValue: number;
  returnPct: number;
  /** Buy and hold over the same window, for comparison. */
  holdReturnPct: number;
  maxDrawdownPct: number;
  trades: SimTrade[];
  wins: number;
  losses: number;
  equity: { t: number; value: number }[];
  /** Points where a decision fired but could not execute, and why. */
  skipped: { t: number; reason: string }[];
};

/** The circuit's decision, in circuit units. Pure and directly testable. */
export function decideLikeCircuit(
  s: BacktestStrategy,
  priceUnits: bigint,
  quoteUnits: bigint,
  baseUnits: bigint
): { action: number; amount: bigint; reason: SimTrade["reason"] | null } {
  const stopHit = priceUnits < s.stopBelow;
  const takeProfit = priceUnits > s.exitAbove;
  const entryHit = priceUnits < s.entryBelow;

  const sell = stopHit || takeProfit;
  const action = sell ? BT_SELL : entryHit ? BT_BUY : BT_HOLD;

  const size = BigInt(s.sizeBps);
  const buySize = (quoteUnits * size) / 10_000n;
  const sellSize = (baseUnits * size) / 10_000n;

  const amount = stopHit
    ? baseUnits
    : action === BT_SELL
      ? sellSize
      : action === BT_BUY
        ? buySize
        : 0n;

  const reason = stopHit ? "stop" : action === BT_SELL ? "take-profit" : action === BT_BUY ? "entry" : null;
  return { action, amount, reason };
}

const QUOTE = 1_000_000; // 6 dp
const BASE = 1_000_000_000; // 9 dp
const PRICE = 1_000_000; // 6 dp

export function runBacktest(
  series: PricePoint[],
  strategy: BacktestStrategy,
  limits: BacktestLimits,
  startingQuote: number
): BacktestResult | null {
  if (series.length === 0) return null;

  let quote = BigInt(Math.round(startingQuote * QUOTE));
  let base = 0n;
  let lastTradeT = 0;

  const trades: SimTrade[] = [];
  const equity: { t: number; value: number }[] = [];
  const skipped: { t: number; reason: string }[] = [];

  const valueAt = (price: number) =>
    Number(quote) / QUOTE + (Number(base) / BASE) * price;

  const startValue = valueAt(series[0].price);
  let peak = startValue;
  let maxDrawdown = 0;

  for (const { t, price } of series) {
    if (!Number.isFinite(price) || price <= 0) continue;
    const priceUnits = BigInt(Math.round(price * PRICE));

    const { action, amount, reason } = decideLikeCircuit(strategy, priceUnits, quote, base);

    if (action !== BT_HOLD && amount > 0n && reason) {
      const isEntry = action === BT_BUY;
      const source = isEntry ? quote : base;

      // execute_trade: entries only are capped and throttled.
      const cap = isEntry ? (source * BigInt(limits.maxTradeBps)) / 10_000n : source;
      const cooling =
        isEntry && lastTradeT > 0 && t - lastTradeT < limits.cooldownSeconds;

      if (cooling) {
        skipped.push({ t, reason: "cooldown" });
      } else if (amount > cap) {
        skipped.push({ t, reason: "above the per-trade cap" });
      } else if (amount > source) {
        skipped.push({ t, reason: "insufficient balance" });
      } else {
        const keep = 1 - limits.costBps / 10_000;
        let amountOut: number;
        if (isEntry) {
          const spend = Number(amount) / QUOTE;
          amountOut = (spend / price) * keep;
          quote -= amount;
          base += BigInt(Math.round(amountOut * BASE));
        } else {
          const sold = Number(amount) / BASE;
          amountOut = sold * price * keep;
          base -= amount;
          quote += BigInt(Math.round(amountOut * QUOTE));
        }
        trades.push({
          t,
          side: isEntry ? 1 : 2,
          price,
          amountIn: isEntry ? Number(amount) / QUOTE : Number(amount) / BASE,
          amountOut,
          reason,
        });
        lastTradeT = t;
      }
    }

    const v = valueAt(price);
    equity.push({ t, value: v });
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const endPrice = series[series.length - 1].price;
  const endValue = valueAt(endPrice);

  // Win/loss is only meaningful on round trips: a buy followed by a sell.
  let wins = 0;
  let losses = 0;
  let openCost: number | null = null;
  for (const tr of trades) {
    if (tr.side === 1) openCost = tr.price;
    else if (openCost !== null) {
      if (tr.price > openCost) wins++;
      else losses++;
      openCost = null;
    }
  }

  const holdReturnPct =
    ((endPrice - series[0].price) / series[0].price) * 100;

  return {
    startValue,
    endValue,
    returnPct: startValue > 0 ? ((endValue - startValue) / startValue) * 100 : 0,
    holdReturnPct,
    maxDrawdownPct: maxDrawdown * 100,
    trades,
    wins,
    losses,
    equity,
    skipped,
  };
}
