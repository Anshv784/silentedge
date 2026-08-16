"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  PAIRS,
  RANGES,
  fetchHistory,
  summarize,
  sparkPath,
  type Candle,
} from "@/lib/market";
import { readOraclePrice } from "@/lib/activity";
import { Panel } from "@/components/readouts";

const PYTH_SOL_USD = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

/**
 * Market context, with provenance attached to every number.
 *
 * The page is built around one distinction that a trading UI usually blurs:
 * which price the *program* acts on, versus which price is being drawn. The
 * first is an on-chain account with freshness and confidence checks; the second
 * is an HTTP feed with neither. Both are shown, and which is which is stated
 * rather than implied, because a chart that looks authoritative is exactly how
 * an unverified number ends up trusted.
 */
export default function MarketPage() {
  const { connection } = useConnection();
  const [pair] = useState(PAIRS[0]);
  const [rangeIdx, setRangeIdx] = useState(1);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [histError, setHistError] = useState<string | null>(null);
  const [oracle, setOracle] = useState<{ price: number; publishedAt: number } | null>(null);

  const range = RANGES[rangeIdx];

  useEffect(() => {
    let alive = true;
    setCandles(null);
    setHistError(null);
    fetchHistory(pair.id, range.days, range.resolution)
      .then((c) => alive && setCandles(c))
      .catch((e) => alive && setHistError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [pair.id, range.days, range.resolution]);

  useEffect(() => {
    let alive = true;
    const read = () =>
      readOraclePrice(connection, PYTH_SOL_USD)
        .then((o) => alive && setOracle(o))
        .catch(() => {});
    read();
    const id = setInterval(read, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [connection]);

  const stats = useMemo(() => (candles ? summarize(candles) : null), [candles]);
  const ageSec = oracle
    ? Math.max(0, Math.round(Date.now() / 1000 - oracle.publishedAt))
    : null;

  return (
    <main className="grid-field min-h-dvh">
      <div className="mx-auto max-w-5xl px-5 pb-24 pt-8 sm:px-8">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-rule)] pb-6">
          <div>
            <Link href="/" className="text-[15px] font-medium tracking-[0.04em] underline-offset-4 hover:underline">
              SilentEdge
            </Link>
            <p className="mt-1 text-[13px] text-[var(--color-ink-soft)]">
              Market context for the pair this vault can trade.
            </p>
          </div>
          <nav className="flex items-center gap-4 text-[13px]">
            <Link href="/app" className="underline-offset-4 hover:underline">
              Vault
            </Link>
            <span className="text-[var(--color-ink-soft)]">Market</span>
          </nav>
        </header>

        {/* ------------------------------------------- execution price */}
        <Panel
          title="Execution price"
          index="01"
          note="The on-chain account the program itself reads."
        >
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <span className="tabular text-[28px]">
              {oracle ? `$${oracle.price.toFixed(2)}` : "…"}
            </span>
            <span className="text-[12px] text-[var(--color-ink-soft)]">
              {ageSec === null
                ? "reading…"
                : ageSec > 30
                  ? `${ageSec}s old — the program would refuse this`
                  : `${ageSec}s old`}
            </span>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
            This is the Pyth price feed account `execute_trade` and
            `evaluate_strategy` read on chain, with staleness, confidence and
            sanity checks applied before it can move money. Everything below is
            context and cannot influence a trade.
          </p>
        </Panel>

        {/* ------------------------------------------- chart */}
        <div className="mt-5">
          <Panel
            title={pair.label}
            index="02"
            note="Historical series from Pyth's public HTTP API — display only."
          >
            <div className="mb-4 flex flex-wrap gap-2">
              {RANGES.map((r, i) => (
                <button
                  key={r.label}
                  onClick={() => setRangeIdx(i)}
                  aria-pressed={i === rangeIdx}
                  className={`border px-3 py-1.5 text-[12px] transition-colors ${
                    i === rangeIdx
                      ? "border-[var(--color-signal)] bg-[var(--color-signal)] text-white"
                      : "border-[var(--color-rule)] hover:bg-[var(--color-paper)]"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {histError ? (
              <p className="text-[12px] text-[var(--color-exposed)]">
                Could not load history: {histError}. The execution price above is
                unaffected — it comes from the chain.
              </p>
            ) : candles === null ? (
              <p className="text-[12px] text-[var(--color-ink-soft)]">Loading…</p>
            ) : candles.length === 0 ? (
              <p className="text-[12px] text-[var(--color-ink-soft)]">
                No candles returned for this window.
              </p>
            ) : (
              <>
                <svg
                  viewBox="0 0 600 160"
                  className="h-40 w-full"
                  role="img"
                  aria-label={`${pair.label} price over the last ${range.label}`}
                >
                  <path
                    d={sparkPath(candles, 600, 160)}
                    fill="none"
                    stroke="var(--color-signal)"
                    strokeWidth="1.5"
                  />
                </svg>
                {stats ? (
                  <dl className="tabular mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-3">
                    <dt className="text-[var(--color-ink-soft)]">Change</dt>
                    <dd className={stats.changePct >= 0 ? "text-[var(--color-shielded)]" : "text-[var(--color-exposed)]"}>
                      {stats.changePct >= 0 ? "+" : ""}
                      {stats.changePct.toFixed(2)}%
                    </dd>
                    <dt className="text-[var(--color-ink-soft)]">High</dt>
                    <dd>${stats.high.toFixed(2)}</dd>
                    <dt className="text-[var(--color-ink-soft)]">Low</dt>
                    <dd>${stats.low.toFixed(2)}</dd>
                    <dt className="text-[var(--color-ink-soft)]">Mean</dt>
                    <dd>${stats.mean.toFixed(2)}</dd>
                    <dt className="text-[var(--color-ink-soft)]">Volatility</dt>
                    <dd>{stats.volAnnualPct.toFixed(1)}% annualised</dd>
                    <dt className="text-[var(--color-ink-soft)]">Max drawdown</dt>
                    <dd>-{stats.maxDrawdownPct.toFixed(1)}%</dd>
                  </dl>
                ) : null}
              </>
            )}
          </Panel>
        </div>

        {/* ------------------------------------------- provenance */}
        <div className="mt-5">
          <Panel title="Where these numbers come from" index="03">
            <dl className="space-y-3 text-[12px] leading-relaxed">
              <div>
                <dt className="font-medium">Oracle data</dt>
                <dd className="text-[var(--color-ink-soft)]">
                  The execution price above. An on-chain Pyth account, validated
                  by the program before it can influence anything.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Display data</dt>
                <dd className="text-[var(--color-ink-soft)]">
                  The chart and every statistic beside it, fetched over HTTP from
                  Pyth&rsquo;s benchmarks API. Same publisher, no on-chain
                  attestation. Fit for drawing a line, unfit for deciding a
                  trade, and never handed to anything that signs.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Derived analysis</dt>
                <dd className="text-[var(--color-ink-soft)]">
                  Change, mean, volatility and drawdown are computed in this
                  browser from the display series. They describe what already
                  happened and forecast nothing.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Your strategy rules</dt>
                <dd className="text-[var(--color-ink-soft)]">
                  Not shown here, and not used by anything on this page. The
                  circuit compares a price to your fixed thresholds — it has no
                  moving average and no volatility term, so nothing above feeds
                  a trading decision.
                </dd>
              </div>
            </dl>
          </Panel>
        </div>

        <p className="mt-8 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
          V1 trades one pair. Others are not listed because they are not
          supported — the vault&rsquo;s mints are compiled into the program.
        </p>
      </div>
    </main>
  );
}
