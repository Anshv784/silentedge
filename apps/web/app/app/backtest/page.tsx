"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { fetchHistory, RANGES, PAIRS, type Candle } from "@/lib/market";
import { runBacktest, type BacktestResult } from "@silentedge/sdk/backtest";
import {
  Alert,
  Block,
  BlockHead,
  Chart,
  Gate,
  PageHead,
  Prov,
  Reveal,
  Row,
  SPRINGS,
  Stat,
} from "@/components/ui";

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
 *
 * The layout is a two-column ledger: rules on the left, the result beside them
 * rather than under 800px of nothing. Editing a threshold and re-reading the
 * return is one glance, not one scroll, and the page has a shape before it has
 * an answer.
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
  /** The window the data actually covered, and whether it came back short. */
  const [ranOver, setRanOver] = useState<{ text: string; short: boolean } | null>(
    null
  );

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

      // Report the window the data actually covered, not the one that was
      // asked for. Pyth's unauthenticated history endpoint reaches back thirty
      // days, so a one-year request comes back short — and a result labelled
      // "1y" that ran over a month is the kind of quiet wrongness this project
      // exists to avoid. See SECURITY.md §4b for the key that lifts it.
      const spanDays = (series[series.length - 1].t - series[0].t) / 86_400;
      const short = spanDays < range.days * 0.9;
      setRanOver({
        short,
        text: short
          ? `${spanDays.toFixed(1)} days of ${PAIRS[0].label}, ${series.length} points — ` +
            `${range.label} was requested, but the price source only goes back that far`
          : `${range.label} of ${PAIRS[0].label}, ${series.length} points`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
    hint?: string
  ) => (
    <label className="block">
      <span className="u-label block text-[var(--color-ink-soft)]">{label}</span>
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        className="field tabular mt-2"
      />
      {hint ? (
        <span className="mt-2 block text-caption text-[var(--color-ink-soft)]">
          {hint}
        </span>
      ) : null}
    </label>
  );

  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

  return (
    <>
      <PageHead
        title="Backtest"
        subtitle="Simulate a rule set over past prices"
      />

      {/* The page's central caveat, at reading size rather than as a 12px
          strip. Copy verbatim from the previous build. `exposed` doubles as
          the caution tone; nothing here is claiming the numbers are on
          chain. */}
      <div
        className="border-l-4 px-5 py-4 text-body"
        style={{
          borderColor: "var(--color-exposed)",
          background:
            "color-mix(in srgb, var(--color-exposed) 10%, transparent)",
        }}
      >
        <strong
          className="font-medium"
          style={{ color: "var(--color-exposed)" }}
        >
          A simulation, not a forecast.
        </strong>{" "}
        <span className="text-[var(--color-ink-soft)]">
          Past prices tell you how a rule set would have behaved, not how it
          will. These results exclude price impact, MEV, and the delay between a
          decision and its execution; a flat cost stands in for spread and fees.
        </span>
      </div>

      {/* Direct child of AnimatePresence, with no wrapper between them, or the
          declared exit never runs. */}
      <AnimatePresence>
        {error ? <Alert tone="bad">{error}</Alert> : null}
      </AnimatePresence>

      <Reveal
        as="div"
        className="ledger mt-8 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] lg:items-start"
      >
        {/* ------------------------------------------------------- the rules
            Sticky, and the row is items-start. The results column runs to a
            hundred and eighty trades; stretched to match it, this card was a
            thousand pixels of empty grey. A control panel should follow the
            thing it controls anyway. */}
        <Block className="lg:sticky lg:top-20">
          <BlockHead
            eyebrow="01"
            title="Rules"
            hint="Typed here — the stored strategy is encrypted and cannot be read back."
          />

          <div className="grid grid-cols-2 gap-x-5 gap-y-6">
            {field("Buy below ($)", entry, setEntry, "150", "leave blank for no entry")}
            {field("Take profit above ($)", exit, setExit, "180", "blank = never")}
            {field("Stop below ($)", stop, setStop, "120", "blank = no stop")}
            {field("Trade size (%)", sizePct, setSizePct, "10", "of the spendable balance")}
            {field("Max per trade (%)", capPct, setCapPct, "10", "entries only")}
            {field("Cooldown (s)", cooldown, setCooldown, "60", "entries only")}
            {field("Cost per fill (bps)", costBps, setCostBps, "30", "spread + fees")}
            {field("Starting balance", start, setStart, "1000", "quote units")}
          </div>

          <div className="u-label mb-3 mt-8 text-[var(--color-ink-faint)]">
            Window
          </div>
          <div className="flex flex-wrap gap-2">
            {RANGES.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setRangeIdx(i)}
                aria-pressed={i === rangeIdx}
                className={`btn relative ${
                  i === rangeIdx
                    ? "border-[var(--color-signal)] text-[var(--color-on-signal)]"
                    : "btn-ghost"
                }`}
              >
                {i === rangeIdx ? (
                  <motion.span
                    aria-hidden
                    layoutId="backtest-window"
                    transition={SPRINGS.snap}
                    className="absolute inset-0 rounded-[4px] bg-[var(--color-signal)]"
                  />
                ) : null}
                <span className="relative">{r.label}</span>
              </button>
            ))}
          </div>

          <button
            onClick={run}
            disabled={running || !hasRule}
            className="btn btn-lg btn-primary mt-6 w-full"
          >
            {running ? "Running…" : "Run backtest"}
          </button>
          {!hasRule ? (
            <p className="mt-3 text-caption text-[var(--color-ink-soft)]">
              Add at least one rule. A strategy with no rules never trades.
            </p>
          ) : null}
        </Block>

        {/* ------------------------------------------------------ the result
            Paper underneath the lattice so that when the result column is
            shorter than the form, the leftover reads as page rather than as a
            slab of rule colour. */}
        <div className="bg-[var(--color-paper)]">
          <div
            className={`grid gap-px bg-[var(--color-void)] sm:grid-cols-2 ${
              result ? "content-start" : "h-full"
            }`}
          >
            {!result ? (
              <div className="bg-[var(--color-paper)] sm:col-span-2">
                <Gate title="Nothing simulated yet">
                  Set at least one rule and run it. The return over the window,
                  the trades it would have taken and the decisions the limits
                  refused all land here.
                </Gate>
              </div>
            ) : (
              <>
                <Block prov="public" className="sm:col-span-2">
                  <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                    <Prov tone="public">Exposed · public price history</Prov>
                    {/* Coverage, always. A window labelled "1y" that ran over a
                        month is exactly the quiet wrongness this page exists to
                        avoid, so the truncation is stated where the number
                        is. */}
                    {ranOver ? (
                      <span
                        className="text-caption"
                        style={{
                          color: ranOver.short
                            ? "var(--color-exposed)"
                            : "var(--color-ink-soft)",
                        }}
                      >
                        {ranOver.text}
                      </span>
                    ) : null}
                  </div>

                  <Stat
                    figure
                    label="Simulated return"
                    value={pct(result.returnPct)}
                    tone={result.returnPct >= 0 ? "pos" : "neg"}
                    sub={`Buy and hold over the same window: ${pct(result.holdReturnPct)}`}
                  />
                </Block>

                <Block>
                  <Stat
                    label="Starting value"
                    value={result.startValue.toFixed(2)}
                  />
                </Block>
                <Block>
                  <Stat label="Ending value" value={result.endValue.toFixed(2)} />
                </Block>
                <Block>
                  <Stat
                    label="Max drawdown"
                    value={`-${result.maxDrawdownPct.toFixed(2)}%`}
                  />
                </Block>
                <Block>
                  <Stat label="Trades" value={result.trades.length} />
                </Block>
                <Block>
                  <Stat
                    label="Round trips"
                    value={
                      result.wins + result.losses === 0
                        ? "none completed"
                        : `${result.wins}W / ${result.losses}L`
                    }
                  />
                </Block>
                <Block>
                  <Stat
                    label="Decisions skipped"
                    value={result.skipped.length}
                  />
                </Block>

                {result.trades.length === 0 ? (
                  <Block className="sm:col-span-2">
                    <p className="max-w-[62ch] text-body text-[var(--color-ink-soft)]">
                      The rules never fired over this window. That is a real
                      result, not an error — the price never crossed a
                      threshold, or every decision was refused by the limits.
                    </p>
                  </Block>
                ) : null}

                {result.equity.length > 1 ? (
                  <Block className="sm:col-span-2">
                    <BlockHead
                      eyebrow="02"
                      title="Simulated equity"
                      hint="Account value in quote units across the window above."
                    />
                    <Chart
                      points={result.equity.map((e) => ({
                        t: e.t,
                        price: e.value,
                      }))}
                      height={220}
                    />
                  </Block>
                ) : null}

                {result.trades.length > 0 ? (
                  <Block className="sm:col-span-2">
                    <BlockHead
                      eyebrow="03"
                      title="Simulated trades"
                      hint={`${result.trades.length} fill${
                        result.trades.length === 1 ? "" : "s"
                      } the rules would have taken.`}
                    />
                    <div className="-mx-1 overflow-x-auto px-1">
                      <table className="tabular w-full text-caption">
                        <thead>
                          <tr className="u-label text-[var(--color-ink-faint)]">
                            <th className="pb-3 text-left font-medium">Side</th>
                            <th className="pb-3 text-left font-medium">
                              Reason
                            </th>
                            <th className="pb-3 text-right font-medium">
                              Price
                            </th>
                            <th className="pb-3 text-right font-medium">In</th>
                            <th className="pb-3 text-right font-medium">Out</th>
                            <th className="pb-3 text-right font-medium">Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.slice(0, 25).map((t, i) => (
                            <tr
                              key={i}
                              className="border-t border-[var(--color-rule)]"
                            >
                              {/* Deliberately not coloured. `pos` and `neg`
                                  mean a number moved up or down; a buy is not
                                  an up. */}
                              <td className="py-2.5 pr-4">
                                {t.side === 1 ? "BUY" : "SELL"}
                              </td>
                              <td className="py-2.5 pr-4 text-[var(--color-ink-soft)]">
                                {t.reason}
                              </td>
                              <td className="py-2.5 pl-4 text-right">
                                ${t.price.toFixed(2)}
                              </td>
                              <td className="py-2.5 pl-4 text-right text-[var(--color-ink-soft)]">
                                {t.amountIn.toFixed(4)}
                              </td>
                              <td className="py-2.5 pl-4 text-right text-[var(--color-ink-soft)]">
                                {t.amountOut.toFixed(4)}
                              </td>
                              <td className="py-2.5 pl-4 text-right text-[var(--color-ink-soft)]">
                                {new Date(t.t * 1000).toLocaleDateString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {result.trades.length > 25 ? (
                      <p className="mt-4 text-caption text-[var(--color-ink-soft)]">
                        Showing 25 of {result.trades.length}.
                      </p>
                    ) : null}
                  </Block>
                ) : null}

                {result.skipped.length > 0 ? (
                  <Block className="sm:col-span-2">
                    <BlockHead
                      eyebrow="04"
                      title="Decisions the limits refused"
                    />
                    <p className="mb-6 max-w-[62ch] text-body text-[var(--color-ink-soft)]">
                      The strategy wanted to act and the vault&rsquo;s own rules
                      said no. These are counted because a backtest that
                      silently drops them overstates how often the strategy
                      would have traded.
                    </p>
                    <div>
                      {Object.entries(
                        result.skipped.reduce<Record<string, number>>(
                          (acc, s) => {
                            acc[s.reason] = (acc[s.reason] ?? 0) + 1;
                            return acc;
                          },
                          {}
                        )
                      ).map(([reason, n]) => (
                        <Row key={reason} label={reason} value={n} />
                      ))}
                    </div>
                  </Block>
                ) : null}
              </>
            )}
          </div>
        </div>
      </Reveal>
    </>
  );
}
