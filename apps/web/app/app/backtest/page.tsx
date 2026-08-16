"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fetchHistory, RANGES, PAIRS, type Candle } from "@/lib/market";
import { runBacktest, type BacktestResult } from "@silentedge/sdk";
import { Panel } from "@/components/readouts";

const usd = (n: string) => BigInt(Math.round(Number(n) * 1e6));
const NEVER_SELL = 18_446_744_073_709_551_615n;
const NEVER_BUY = 0n;
const NO_STOP = 0n;

/**
 * Backtesting, against the same decision the circuit makes.
 *
 * One thing to be straight about up front: this cannot backtest the strategy
 * stored on chain. That strategy is encrypted to the MPC cluster and nobody —
 * including this page, including us — can read it back. So the rules are typed
 * here, and the page says so rather than implying it loaded them.
 *
 * The engine is `runBacktest` from the SDK, which mirrors
 * `evaluate_strategy_v3` and `execute_trade` statement for statement and is
 * tested against them in tests/backtest.ts. A simulator that quietly diverges
 * from production is how a user ends up funding a strategy they never tested.
 */
export default function BacktestPage() {
  const [entry, setEntry] = useState("");
  const [exit, setExit] = useState("");
  const [stop, setStop] = useState("");
  const [sizePct, setSizePct] = useState("10");
  const [capPct, setCapPct] = useState("10");
  const [cooldown, setCooldown] = useState("60");
  const [costBps, setCostBps] = useState("30");
  const [start, setStart] = useState("1000");
  const [rangeIdx, setRangeIdx] = useState(2);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [ranOver, setRanOver] = useState<string | null>(null);

  const hasRule = entry.trim() || exit.trim() || stop.trim();

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const range = RANGES[rangeIdx];
      const candles: Candle[] = await fetchHistory(
        PAIRS[0].id,
        range.days,
        range.resolution
      );
      if (candles.length === 0) {
        setError(
          "No historical candles were returned for that window. Nothing to simulate — this is an empty result, not a zero return."
        );
        return;
      }
      const series = candles.map((c) => ({ t: c.t, price: c.c }));
      const r = runBacktest(
        series,
        {
          entryBelow: entry.trim() ? usd(entry) : NEVER_BUY,
          exitAbove: exit.trim() ? usd(exit) : NEVER_SELL,
          stopBelow: stop.trim() ? usd(stop) : NO_STOP,
          sizeBps: Math.round(Number(sizePct) * 100),
        },
        {
          maxTradeBps: Math.round(Number(capPct) * 100),
          cooldownSeconds: Math.round(Number(cooldown)),
          costBps: Math.round(Number(costBps)),
        },
        Number(start)
      );
      setResult(r);
      setRanOver(`${range.label} of ${PAIRS[0].label}, ${series.length} points`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const equityPath = useMemo(() => {
    if (!result || result.equity.length < 2) return "";
    const vals = result.equity.map((e) => e.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const step = 596 / (vals.length - 1);
    return vals
      .map((v, i) => `${i === 0 ? "M" : "L"}${(2 + i * step).toFixed(2)},${(2 + 116 * (1 - (v - min) / span)).toFixed(2)}`)
      .join(" ");
  }, [result]);

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
    hint?: string
  ) => (
    <label className="text-[11px]">
      <span className="text-[var(--color-ink-soft)]">{label}</span>
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        className="tabular mt-1 w-full border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5 text-[12px]"
      />
      {hint ? (
        <span className="mt-1 block text-[10px] text-[var(--color-ink-soft)]">{hint}</span>
      ) : null}
    </label>
  );

  return (
    <main className="grid-field min-h-dvh">
      <div className="mx-auto max-w-5xl px-5 pb-24 pt-8 sm:px-8">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-rule)] pb-6">
          <div>
            <Link href="/" className="text-[15px] font-medium tracking-[0.04em] underline-offset-4 hover:underline">
              SilentEdge
            </Link>
            <p className="mt-1 text-[13px] text-[var(--color-ink-soft)]">
              Simulate a rule set over past prices.
            </p>
          </div>
          <nav className="flex items-center gap-4 text-[13px]">
            <Link href="/app" className="underline-offset-4 hover:underline">Vault</Link>
            <Link href="/app/market" className="underline-offset-4 hover:underline">Market</Link>
            <span className="text-[var(--color-ink-soft)]">Backtest</span>
          </nav>
        </header>

        <div className="mb-5 border border-[var(--color-exposed)] px-4 py-3 text-[12px] leading-relaxed">
          <strong>A simulation, not a forecast.</strong> Past prices tell you how
          a rule set would have behaved, not how it will. These results exclude
          price impact, MEV, and the delay between a decision and its execution;
          a flat cost stands in for spread and fees.
        </div>

        <Panel title="Rules" index="01" note="Typed here — the stored strategy is encrypted and cannot be read back.">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {field("Buy below ($)", entry, setEntry, "150", "leave blank for no entry")}
            {field("Take profit above ($)", exit, setExit, "180", "blank = never")}
            {field("Stop below ($)", stop, setStop, "120", "blank = no stop")}
            {field("Trade size (%)", sizePct, setSizePct, "10", "of the spendable balance")}
            {field("Max per trade (%)", capPct, setCapPct, "10", "entries only")}
            {field("Cooldown (s)", cooldown, setCooldown, "60", "entries only")}
            {field("Cost per fill (bps)", costBps, setCostBps, "30", "spread + fees")}
            {field("Starting balance", start, setStart, "1000", "quote units")}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {RANGES.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setRangeIdx(i)}
                aria-pressed={i === rangeIdx}
                className={`border px-3 py-1.5 text-[12px] ${
                  i === rangeIdx
                    ? "border-[var(--color-signal)] bg-[var(--color-signal)] text-white"
                    : "border-[var(--color-rule)] hover:bg-[var(--color-paper)]"
                }`}
              >
                {r.label}
              </button>
            ))}
            <button
              onClick={run}
              disabled={running || !hasRule}
              className="ml-auto border border-[var(--color-signal)] bg-[var(--color-signal)] px-4 py-1.5 text-[12px] text-white disabled:opacity-40"
            >
              {running ? "Running…" : "Run backtest"}
            </button>
          </div>
          {!hasRule ? (
            <p className="mt-2 text-[11px] text-[var(--color-ink-soft)]">
              Add at least one rule. A strategy with no rules never trades.
            </p>
          ) : null}
        </Panel>

        {error ? (
          <div className="mt-5 border border-[var(--color-exposed)] px-4 py-3 text-[12px] text-[var(--color-exposed)]">
            {error}
          </div>
        ) : null}

        {result ? (
          <div className="mt-5 space-y-5">
            <Panel title="Result" index="02" note={ranOver ?? undefined}>
              <dl className="tabular grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-3">
                <dt className="text-[var(--color-ink-soft)]">Starting value</dt>
                <dd>{result.startValue.toFixed(2)}</dd>
                <dt className="text-[var(--color-ink-soft)]">Ending value</dt>
                <dd>{result.endValue.toFixed(2)}</dd>
                <dt className="text-[var(--color-ink-soft)]">Return</dt>
                <dd className={result.returnPct >= 0 ? "text-[var(--color-shielded)]" : "text-[var(--color-exposed)]"}>
                  {result.returnPct >= 0 ? "+" : ""}{result.returnPct.toFixed(2)}%
                </dd>
                <dt className="text-[var(--color-ink-soft)]">Buy and hold</dt>
                <dd>{result.holdReturnPct >= 0 ? "+" : ""}{result.holdReturnPct.toFixed(2)}%</dd>
                <dt className="text-[var(--color-ink-soft)]">Max drawdown</dt>
                <dd>-{result.maxDrawdownPct.toFixed(2)}%</dd>
                <dt className="text-[var(--color-ink-soft)]">Trades</dt>
                <dd>{result.trades.length}</dd>
                <dt className="text-[var(--color-ink-soft)]">Round trips</dt>
                <dd>
                  {result.wins + result.losses === 0
                    ? "none completed"
                    : `${result.wins}W / ${result.losses}L`}
                </dd>
                <dt className="text-[var(--color-ink-soft)]">Decisions skipped</dt>
                <dd>{result.skipped.length}</dd>
              </dl>

              {result.trades.length === 0 ? (
                <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
                  The rules never fired over this window. That is a real result,
                  not an error — the price never crossed a threshold, or every
                  decision was refused by the limits.
                </p>
              ) : null}

              {equityPath ? (
                <svg viewBox="0 0 600 120" className="mt-4 h-28 w-full" role="img" aria-label="Simulated equity curve">
                  <path d={equityPath} fill="none" stroke="var(--color-signal)" strokeWidth="1.5" />
                </svg>
              ) : null}
            </Panel>

            {result.skipped.length > 0 ? (
              <Panel title="Decisions the limits refused" index="03">
                <p className="mb-2 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                  The strategy wanted to act and the vault&rsquo;s own rules said
                  no. These are counted because a backtest that silently drops
                  them overstates how often the strategy would have traded.
                </p>
                <ul className="tabular space-y-1 text-[11px]">
                  {Object.entries(
                    result.skipped.reduce<Record<string, number>>((acc, s) => {
                      acc[s.reason] = (acc[s.reason] ?? 0) + 1;
                      return acc;
                    }, {})
                  ).map(([reason, n]) => (
                    <li key={reason} className="flex justify-between">
                      <span className="text-[var(--color-ink-soft)]">{reason}</span>
                      <span>{n}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {result.trades.length > 0 ? (
              <Panel title="Simulated trades" index="04">
                <ul className="tabular divide-y divide-[var(--color-rule)] text-[11px]">
                  {result.trades.slice(0, 25).map((t, i) => (
                    <li key={i} className="flex flex-wrap justify-between gap-2 py-1.5">
                      <span>
                        {t.side === 1 ? "BUY" : "SELL"} · {t.reason}
                      </span>
                      <span className="text-[var(--color-ink-soft)]">
                        ${t.price.toFixed(2)} · in {t.amountIn.toFixed(4)} · out{" "}
                        {t.amountOut.toFixed(4)} ·{" "}
                        {new Date(t.t * 1000).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
                {result.trades.length > 25 ? (
                  <p className="mt-2 text-[11px] text-[var(--color-ink-soft)]">
                    Showing 25 of {result.trades.length}.
                  </p>
                ) : null}
              </Panel>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
