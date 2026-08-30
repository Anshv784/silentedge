"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { analyze } from "@silentedge/sdk/indicators";
import {
  Alert,
  Badge,
  Block,
  PageHead,
  Prov,
  Reveal,
  Row,
  SPRINGS,
  Ticking,
} from "@/components/ui";
import { PairPicker } from "@/components/pair-picker";
import {
  DrawingToolbar,
  PALETTE,
  type Drawing,
  type Tool,
} from "@/components/drawings";
import {
  OhlcLegend,
  Terminal,
  type Hover,
  type Overlay,
  type Study,
} from "@/components/terminal";
import { readOraclePrice } from "@/lib/activity";
import {
  DEFAULT_TIMEFRAME,
  POPULAR,
  TIMEFRAMES,
  TRADABLE,
  fetchCandles,
  fetchCatalog,
  pct,
  price as fmtPrice,
  summarize,
  type Candle,
  type Pair,
} from "@/lib/market";

const PYTH_SOL_USD = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

/**
 * The terminal.
 *
 * Every pair Pyth publishes, at every resolution it supports, with the studies
 * a trader expects to find. The page is built around one distinction that a
 * trading UI usually blurs: which price the *program* acts on, versus which
 * price is being drawn.
 *
 * The first is an on-chain account with staleness, confidence and sanity
 * checks. The second is an HTTP feed with none of them. Both are shown, and
 * which is which is stated rather than implied, because a chart that looks
 * authoritative is exactly how an unverified number ends up trusted.
 *
 * The same distinction governs the pair list: five hundred pairs chart here and
 * one of them trades. That is a property of the deployed program — the mints
 * are compiled in — so the badge is derived, never configured.
 *
 * This is the densest working screen in the product, so it runs the lattice
 * rather than the editorial register: a twelve-column `.ledger` of cells
 * sharing hairlines, the chart spanning eight columns by two rows, and one
 * figure — the display price. The provenance copy used to sit in a fourth card
 * of its own, at the same border, radius and padding as the live market data
 * beside it. It now attaches to the values it describes: the same words, on the
 * thing they are about, reachable from the label rather than from a legend.
 */

const OVERLAYS: { id: Overlay; label: string }[] = [
  { id: "ema", label: "EMA 21/99" },
  { id: "bollinger", label: "Bollinger" },
];

const STUDIES: { id: Study; label: string }[] = [
  { id: "rsi", label: "RSI" },
  { id: "macd", label: "MACD" },
];

const VERDICT_COLOR: Record<string, string> = {
  up: "var(--color-pos)",
  down: "var(--color-neg)",
  flat: "var(--color-ink-faint)",
};

/**
 * A provenance chip that carries its own note.
 *
 * The alternative — and what this page used to do — is a separate card headed
 * "Where these numbers come from", ~150 words at the same visual weight as the
 * live prices it describes. The words are unchanged; they are attached to the
 * label of the value they explain instead of filed at the bottom of the page,
 * and they open on hover, on focus and on click, so a keyboard reaches them the
 * same way a pointer does.
 *
 * The note is absolutely positioned on purpose: expanding it in flow would
 * reflow the chart underneath every time a pointer crossed a label.
 */
function Explain({
  label,
  tone,
  right,
  children,
}: {
  label: string;
  tone: "public" | "private";
  /** Anchor the note to the right edge, for chips near the viewport edge. */
  right?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const color =
    tone === "public" ? "var(--color-exposed)" : "var(--color-shielded)";

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="border-b border-dotted border-[var(--color-rule-strong)] pb-1 text-left transition-colors hover:border-[var(--color-ink-soft)]"
      >
        <Prov tone={tone}>{label}</Prov>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.span
            id={id}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12, ease: [0.65, 0, 0.35, 1] }}
            className={`absolute top-full z-20 mt-2 block w-[46ch] max-w-[calc(100vw-3rem)] border border-[var(--color-rule)] bg-[var(--color-panel)] p-4 text-caption text-[var(--color-ink-soft)] ${
              right ? "right-0" : "left-0"
            }`}
            style={{ borderLeft: `3px solid ${color}` }}
          >
            {children}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}

export default function TerminalPage() {
  const { connection } = useConnection();
  const [pair, setPair] = useState<Pair>(POPULAR[0]);
  const [tfIdx, setTfIdx] = useState(DEFAULT_TIMEFRAME);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  /**
   * Set when the source returned far fewer bars than were asked for.
   *
   * Pyth's unauthenticated history endpoint reaches back thirty days, so the
   * slow timeframes come back short — a 1W chart is about four candles. That
   * is real data and not an error, but a chart silently showing four bars
   * where five hundred were requested reads as a dead market rather than as a
   * limit of the feed, so it is said out loud.
   */
  const [thin, setThin] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overlays, setOverlays] = useState<Overlay[]>(["ema"]);
  const [studies, setStudies] = useState<Study[]>(["rsi"]);
  const [hover, setHover] = useState<Hover>(null);
  const [oracle, setOracle] = useState<{
    price: number;
    publishedAt: number;
  } | null>(null);
  /* Annotations, per pair, in memory only — see components/drawings.tsx for
     why they are never written to disk. Keyed by pair so switching to BTC and
     back does not wipe what you drew on SOL. */
  const [tool, setTool] = useState<Tool>("cursor");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [byPair, setByPair] = useState<Record<string, Drawing[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const drawings = byPair[pair.id] ?? [];

  const commit = useCallback(
    (d: Drawing) =>
      setByPair((m) => ({ ...m, [pair.id]: [...(m[pair.id] ?? []), d] })),
    [pair.id]
  );
  const removeSelected = useCallback(() => {
    if (!selected) return;
    setByPair((m) => ({
      ...m,
      [pair.id]: (m[pair.id] ?? []).filter((d) => d.id !== selected),
    }));
    setSelected(null);
  }, [pair.id, selected]);
  const clearAll = useCallback(() => {
    setByPair((m) => ({ ...m, [pair.id]: [] }));
    setSelected(null);
  }, [pair.id]);

  const tf = TIMEFRAMES[tfIdx];

  // Deep link from the markets table: /app/market?pair=BTC. Read from the URL
  // in an effect rather than through useSearchParams, which would force this
  // statically-prerendered page behind a Suspense boundary for one string.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search)
      .get("pair")
      ?.toUpperCase();
    if (!want) return;
    fetchCatalog().then((all) => {
      const hit = all.find((p) => p.base === want);
      if (hit) setPair(hit);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    setCandles(null);
    setError(null);
    setThin(null);
    setHover(null);
    const load = () =>
      fetchCandles(pair.id, tf, 500)
        .then((c) => {
          if (!alive) return;
          if (c.length === 0) {
            setError(
              `Pyth returned no candles for ${pair.label} at ${tf.label}.`
            );
          }
          setThin(c.length > 0 && c.length < 60 ? c.length : null);
          setCandles(c);
        })
        .catch((e) => alive && setError(String(e?.message ?? e)));
    load();
    // Refresh at a fraction of the candle size, clamped so the 1m chart does
    // not hammer the endpoint and the 1W chart is not frozen for a week.
    const every = Math.min(Math.max(tf.seconds / 4, 15), 120) * 1_000;
    const id = setInterval(load, every);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pair.id, pair.label, tf]);

  // The on-chain account, only for the pair the program actually reads.
  useEffect(() => {
    if (!pair.tradable) {
      setOracle(null);
      return;
    }
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
  }, [connection, pair.tradable]);

  const stats = useMemo(() => (candles ? summarize(candles) : null), [candles]);
  const last =
    candles && candles.length > 0 ? candles[candles.length - 1] : null;
  const spot = last?.c ?? null;

  const ta = useMemo(() => (candles ? analyze(candles) : null), [candles]);
  const ageSec = oracle
    ? Math.max(0, Math.round(Date.now() / 1000 - oracle.publishedAt))
    : null;

  const onHover = useCallback((h: Hover) => setHover(h), []);

  const up = stats ? stats.changePct >= 0 : true;
  const dirColor = up ? "var(--color-pos)" : "var(--color-neg)";
  const chartH = 440 + studies.length * 90;

  const chip = (on: boolean) =>
    `rounded border px-2.5 py-1 text-caption transition-colors ${
      on
        ? "border-[var(--color-signal)] text-[var(--color-signal-hi)] bg-[color-mix(in_srgb,var(--color-signal)_12%,transparent)]"
        : "border-[var(--color-rule-strong)] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-soft)]"
    }`;

  return (
    <>
      <PageHead
        title="Terminal"
        subtitle="Every pair Pyth publishes. One of them this vault can trade."
        actions={
          <Link href="/app/markets" className="btn btn-ghost">
            All markets
          </Link>
        }
      />

      <Reveal className="ledger xl:grid-cols-12">
        {/* ------------------------------------------------- the display price
            The one figure on the screen. Everything else is title size or
            smaller, and the pair it belongs to is selected from inside the
            same cell rather than from a toolbar somewhere else. */}
        <Block prov="public" className="xl:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <Explain label="Display price" tone="public">
              The chart and every statistic beside it, fetched over HTTP
              relayed by this site from Pyth. Same publisher, no on-chain
              attestation. Fit for drawing a line, unfit for deciding a trade,
              and never handed to anything that signs.
            </Explain>
            <PairPicker value={pair} onChange={setPair} />
          </div>

          <div className="tabular mt-6 text-figure">
            {spot === null ? (
              <span className="text-[var(--color-ink-faint)]">—</span>
            ) : (
              <Ticking
                value={spot}
                kind="feed"
                cell
                format={(n) => `$${fmtPrice(n)}`}
              />
            )}
          </div>
          <div className="tabular mt-4 text-caption" style={{ color: dirColor }}>
            {stats
              ? `${pct(stats.changePct)} over ${stats.points} × ${tf.label}`
              : "…"}
          </div>
        </Block>

        {/* --------------------------------------------- the execution price
            The number the program actually acts on. Its explanation hangs off
            its own label, so the distinction is one hover away from the thing
            it distinguishes instead of ~150 words below the fold. */}
        <Block prov="public" className="xl:col-span-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <Explain label="Execution price" tone="public" right>
              An on-chain Pyth account, validated by the program for staleness,
              confidence and sanity before it can influence anything. Exists
              here only for {TRADABLE.label}.
            </Explain>
            {pair.tradable ? (
              <Badge tone="good" dot>
                Tradable by this vault
              </Badge>
            ) : (
              <Badge tone="neutral">Analysis only</Badge>
            )}
          </div>

          {pair.tradable ? (
            <>
              <div className="tabular mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-title">
                {oracle ? (
                  <Ticking
                    value={oracle.price}
                    kind="feed"
                    format={(n) => `$${fmtPrice(n)}`}
                  />
                ) : (
                  <span className="text-[var(--color-ink-faint)]">reading…</span>
                )}
                {ageSec !== null ? (
                  <span
                    className="text-caption"
                    style={{
                      color:
                        ageSec > 30
                          ? "var(--color-exposed)"
                          : "var(--color-ink-faint)",
                    }}
                  >
                    {ageSec}s old
                  </span>
                ) : null}
              </div>
              <p className="mt-4 text-caption text-[var(--color-ink-soft)]">
                The on-chain Pyth account the program reads and validates. The
                chart is not it.
              </p>
            </>
          ) : (
            <p className="mt-6 text-caption text-[var(--color-ink-soft)]">
              This vault cannot trade {pair.label}. Its mints are compiled into
              the program, so only{" "}
              <button
                className="underline underline-offset-2 hover:text-[var(--color-ink)]"
                onClick={() => setPair(TRADABLE)}
              >
                {TRADABLE.label}
              </button>{" "}
              has an execution price here.
            </p>
          )}
        </Block>

        {/* -------------------------------------------------------- the chart
            Eight columns by two rows. The five statistics moved into this
            cell's own header strip, where they describe the series being
            drawn rather than crowding the two live prices above. */}
        <Block prov="public" className="xl:col-span-8 xl:row-span-2">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <Prov tone="public">Exposed · public price data</Prov>
            <div className="flex flex-wrap gap-0.5">
              {TIMEFRAMES.map((t, i) => (
                <button
                  key={t.label}
                  onClick={() => setTfIdx(i)}
                  aria-pressed={i === tfIdx}
                  className={`relative rounded px-2.5 py-1 text-caption font-medium transition-colors ${
                    i === tfIdx
                      ? "text-[var(--color-on-signal)]"
                      : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  {i === tfIdx ? (
                    <motion.span
                      layoutId="tf-active"
                      aria-hidden
                      className="absolute inset-0 rounded bg-[var(--color-signal)]"
                      transition={SPRINGS.snap}
                    />
                  ) : null}
                  <span className="relative">{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          <dl className="mt-6 flex flex-wrap gap-x-9 gap-y-4">
            {(
              [
                ["High", stats ? `$${fmtPrice(stats.high)}` : "—"],
                ["Low", stats ? `$${fmtPrice(stats.low)}` : "—"],
                ["Mean", stats ? `$${fmtPrice(stats.mean)}` : "—"],
                ["Vol ann.", stats ? `${stats.volAnnualPct.toFixed(0)}%` : "—"],
                [
                  "Drawdown",
                  stats ? `-${stats.maxDrawdownPct.toFixed(1)}%` : "—",
                ],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="u-label text-[var(--color-ink-faint)]">{k}</dt>
                <dd className="tabular mt-1.5 text-[15px]">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 flex flex-wrap items-center gap-1.5">
            {OVERLAYS.map((o) => (
              <button
                key={o.id}
                aria-pressed={overlays.includes(o.id)}
                onClick={() =>
                  setOverlays((v) =>
                    v.includes(o.id) ? v.filter((x) => x !== o.id) : [...v, o.id]
                  )
                }
                className={chip(overlays.includes(o.id))}
              >
                {o.label}
              </button>
            ))}
            <span
              className="mx-1.5 h-4 w-px bg-[var(--color-rule-strong)]"
              aria-hidden
            />
            {STUDIES.map((s) => (
              <button
                key={s.id}
                aria-pressed={studies.includes(s.id)}
                onClick={() =>
                  setStudies((v) =>
                    v.includes(s.id) ? v.filter((x) => x !== s.id) : [...v, s.id]
                  )
                }
                className={chip(studies.includes(s.id))}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="mt-6 border-t border-[var(--color-rule)]">
            <DrawingToolbar
              tool={tool}
              setTool={setTool}
              color={color}
              setColor={setColor}
              count={drawings.length}
              selected={selected}
              onDelete={removeSelected}
              onClear={clearAll}
            />
          </div>

          <p className="mt-4 text-caption text-[var(--color-ink-soft)]">
            Your annotations stay in this tab and are never written to disk: a
            line drawn at the price you intend to buy says the same thing your
            encrypted thresholds do.
          </p>

          <div className="mt-4">
            <OhlcLegend hover={hover} latest={last} />
          </div>

          {/* The wrapper is static and the Alert is the direct child, so its
              declared exit actually runs — it used to blink out of existence
              because no call site had an AnimatePresence ancestor. */}
          <div className="mt-4 empty:hidden">
            <AnimatePresence initial={false}>
              {thin !== null ? (
                <Alert
                  tone="warn"
                  title={`Only ${thin} candles at this timeframe.`}
                >
                  Pyth put its deep-history endpoint behind an API key on
                  26 August 2026. Without one, the public source this site
                  relays reaches back thirty days, which is only a few bars at{" "}
                  {tf.label}. The candles shown are real; there are simply not
                  many of them. Faster timeframes are unaffected.
                </Alert>
              ) : null}
            </AnimatePresence>
          </div>

          {error && (!candles || candles.length === 0) ? (
            <div className="mt-4">
              <Alert tone="warn" title="No chart.">
                {error} The feed exists in the catalog but has no candles at
                this resolution — try a slower timeframe.
              </Alert>
            </div>
          ) : candles === null ? (
            /* The loading state is the chart's own ruling, not a grey slab:
               the horizontal rules the candles will land between, at 30%. */
            <div className="relative mt-4" style={{ height: chartH }}>
              <div
                aria-hidden
                className="absolute inset-0 opacity-30"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(to bottom, var(--color-rule) 0 1px, transparent 1px 60px)",
                }}
              />
              <div className="absolute inset-0 flex items-center justify-center text-caption text-[var(--color-ink-faint)]">
                Loading live candles…
              </div>
            </div>
          ) : (
            <motion.div
              className="-mx-2 mt-4"
              initial={{ opacity: 0, scale: 0.995 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            >
              <Terminal
                candles={candles}
                overlays={overlays}
                studies={studies}
                height={chartH}
                onHover={onHover}
                drawing={{
                  tool,
                  color,
                  drawings,
                  onCommit: commit,
                  selected,
                  onSelect: setSelected,
                }}
              />
            </motion.div>
          )}

          <p className="mt-6 border-t border-[var(--color-rule)] pt-4 text-caption text-[var(--color-ink-soft)]">
            No volume, and no order book. Pyth publishes prices, not trades —
            its history returns a volume array of zeros — and the vault swaps
            through Jupiter rather than against a book. Drawing either would put
            an invented number exactly where a trader looks for a measured one.
          </p>
        </Block>

        {/* ----------------------------------------------------- the readings
            "Derived analysis" used to be a definition in a legend at the
            bottom of the page. It is the header of the cell it defines. */}
        <Block prov="public" className="xl:col-span-4">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <Explain label="Derived analysis" tone="public" right>
              Every indicator here is computed in this browser from the display
              series. They describe what already happened and forecast nothing.
            </Explain>
            {ta ? (
              <Badge
                tone={
                  ta.up > ta.down ? "good" : ta.down > ta.up ? "bad" : "neutral"
                }
              >
                {ta.up}↑ {ta.down}↓ {ta.flat}→
              </Badge>
            ) : null}
          </div>
          <h2 className="mt-4 text-lead font-medium">Technical readings</h2>
          <p className="mt-1.5 text-caption text-[var(--color-ink-soft)]">
            Where the price sits relative to each indicator, right now.
          </p>

          {!ta ? (
            <p className="mt-5 text-caption text-[var(--color-ink-soft)]">
              {candles === null
                ? "Loading…"
                : "Not enough candles at this timeframe to warm the indicators up."}
            </p>
          ) : (
            <>
              <ul className="mt-5 divide-y divide-[var(--color-rule)]">
                {ta.readings.map((r) => (
                  <li key={r.name} className="py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-caption">{r.name}</span>
                      <span className="tabular text-caption text-[var(--color-ink-soft)]">
                        {r.value}
                      </span>
                    </div>
                    <div
                      className="mt-1 text-caption"
                      style={{ color: VERDICT_COLOR[r.verdict] }}
                    >
                      {r.note}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-[var(--color-rule)] pt-4 text-caption">
                {ta.summary}
              </p>
              <p className="mt-3 text-caption text-[var(--color-ink-soft)]">
                Each line is a comparison that already happened, not a
                prediction, and the tally counts those comparisons — it is not a
                recommendation. None of it can reach the circuit: a strategy
                compares one price to three fixed thresholds and has no moving
                average or oscillator to read.
              </p>
            </>
          )}

          {/* The one shielded rail on the page, on the one thing that is not
              here. Verbatim from the old legend; the rule replaces the
              sentence that used to have to say which side it was on. */}
          <div className="prov prov-private mt-6">
            <div className="u-label text-[var(--color-shielded)]">
              Your strategy rules
            </div>
            <p className="mt-2 text-caption text-[var(--color-ink-soft)]">
              Not shown, and not used by anything on this page. They are
              encrypted to the MPC cluster and no page can read them back.
            </p>
          </div>
        </Block>

        {/* -------------------------------------------------------- the levels */}
        <Block prov="public" className="xl:col-span-4">
          <Prov tone="public">Levels · derived</Prov>
          <h2 className="mt-4 text-lead font-medium">Levels &amp; volatility</h2>
          <p className="mt-1.5 text-caption text-[var(--color-ink-soft)]">
            Swing highs and lows nearest the current price.
          </p>

          {!ta ? (
            <p className="mt-5 text-caption text-[var(--color-ink-soft)]">—</p>
          ) : (
            <>
              <div className="mt-5">
                <Row
                  label="Resistance"
                  value={
                    ta.resistance.length
                      ? ta.resistance.map((r) => fmtPrice(r)).join("  ")
                      : "none in view"
                  }
                />
                <Row
                  label="Support"
                  value={
                    ta.support.length
                      ? ta.support.map((r) => fmtPrice(r)).join("  ")
                      : "none in view"
                  }
                />
                <Row
                  label="ATR 14"
                  value={
                    ta.atr === null
                      ? "—"
                      : `${fmtPrice(ta.atr)}${
                          ta.atrPct !== null
                            ? ` (${ta.atrPct.toFixed(2)}%)`
                            : ""
                        }`
                  }
                  hint="per candle"
                />
              </div>
              {pair.tradable && ta.atrPct !== null ? (
                <p className="mt-5 text-caption text-[var(--color-ink-soft)]">
                  A typical {tf.label} candle moves about{" "}
                  {ta.atrPct.toFixed(2)}%. A stop tighter than that gets hit by
                  ordinary noise rather than by the move it exists to catch —
                  worth knowing before setting one in the{" "}
                  <Link
                    href="/app/strategy"
                    className="underline underline-offset-2 hover:text-[var(--color-ink)]"
                  >
                    studio
                  </Link>
                  .
                </p>
              ) : null}
            </>
          )}
        </Block>
      </Reveal>
    </>
  );
}
