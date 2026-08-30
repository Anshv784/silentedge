"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BASE_SYMBOL, QUOTE_SYMBOL } from "@silentedge/config";
import {
  MAX_NAME_LENGTH,
  NEVER_BUY,
  NEVER_SELL,
  NO_STOP,
  emptyStrategy,
  toPriceUnits,
  validateStrategy,
  type RuleKind,
  type Strategy,
} from "@silentedge/types";
import { runBacktest, type BacktestResult } from "@silentedge/sdk/backtest";
import { WalletButton } from "@/components/shell";
import {
  Alert,
  Badge,
  Block,
  BlockHead,
  Eyebrow,
  PageHead,
  Prov,
  Reveal,
  Row,
  SPRINGS,
  Seal,
  Ticking,
} from "@/components/ui";
import { OhlcLegend, Terminal, type Hover } from "@/components/terminal";
import { useVaultStore } from "@/lib/vault-store";
import { DEFAULT_LIMITS } from "@/lib/vault-program";
import {
  DEFAULT_TIMEFRAME,
  TIMEFRAMES,
  TRADABLE,
  fetchCandles,
  price as fmtPrice,
  type Candle,
} from "@/lib/market";

/**
 * The studio.
 *
 * Inputs on the left, the outcome on the right. It used to be seven cards of
 * identical weight, which meant the page's actual output — a simulation
 * against the same decision function the deployed circuit runs — was rendered
 * at 11px in a badge and 15px in a table cell, smaller than the explanatory
 * copy around it.
 *
 * The simulation is now the largest object here: the return at `--text-figure`
 * over a 280px equity curve, with buy-and-hold drawn as a second line on the
 * SAME axes. The benchmark is what makes the return mean anything — a strategy
 * that returns 4% in a window where holding returned 30% lost money, and that
 * comparison was previously a text cell in a four-column list.
 *
 * Nothing here is a forecast, and no number on this page is presented as one.
 * The "not modelled" disclosure below the trade list ships verbatim.
 */

const KINDS: {
  kind: RuleKind;
  label: string;
  op: string;
  action: string;
  color: string;
  hint: string;
}[] = [
  {
    kind: "entry",
    label: "Entry",
    op: "price <",
    action: `BUY ${BASE_SYMBOL}`,
    color: "var(--color-signal-hi)",
    hint: `Spend ${QUOTE_SYMBOL} when the price drops under this level.`,
  },
  {
    kind: "exit",
    label: "Take profit",
    op: "price >",
    action: `SELL ${BASE_SYMBOL}`,
    color: "var(--color-pos)",
    hint: `Sell back into ${QUOTE_SYMBOL} when the price rises above this level.`,
  },
  {
    kind: "stop",
    label: "Stop loss",
    op: "price <",
    action: "SELL ALL",
    color: "var(--color-neg)",
    hint: "Exit the whole position. Exempt from the size cap and the cooldown.",
  },
];

/**
 * Presets are offsets from spot, not signals.
 *
 * They exist so a first strategy is one click away instead of three guesses,
 * and each is described by what it does rather than by an implied edge. Nothing
 * here predicts anything: the circuit compares a price to three fixed numbers
 * and has no notion of trend, momentum or volatility.
 */
const PRESETS: {
  id: string;
  name: string;
  blurb: string;
  offsets: { entry?: number; exit?: number; stop?: number };
  sizeBps: number;
}[] = [
  {
    id: "range",
    name: "Range",
    blurb: "Buy 4% under spot, take profit 6% over, stop 10% under.",
    offsets: { entry: -4, exit: 6, stop: -10 },
    sizeBps: 1_000,
  },
  {
    id: "dip",
    name: "Deep dip",
    blurb: "Only buys a 12% drawdown. Wide 20% stop, patient 15% target.",
    offsets: { entry: -12, exit: 15, stop: -20 },
    sizeBps: 2_000,
  },
  {
    id: "tight",
    name: "Tight scalp",
    blurb: "1.5% under, 2.5% over, 4% stop. Fires often — pays spread often.",
    offsets: { entry: -1.5, exit: 2.5, stop: -4 },
    sizeBps: 500,
  },
  {
    id: "protect",
    name: "Protect only",
    blurb: "No entries. A standing stop 8% under spot on what you already hold.",
    offsets: { stop: -8 },
    sizeBps: 1_000,
  },
];

const money = (n: number, dp = 2) =>
  n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** The one figure on this screen. Two decimals until the number needs the room. */
const pct = (n: number) =>
  `${n >= 0 ? "+" : ""}${n.toFixed(Math.abs(n) >= 100 ? 0 : 2)}%`;

const CURVE_W = 1000;
const CURVE_H = 280;


/* ------------------------------------------------------------ guardrails */

/**
 * Every check the deployed program runs before a swap can settle.
 *
 * This exists because "buy under X, sell over Y" is a limit order, and a limit
 * order is a single comparison. What makes this different is not the rule — it
 * is that the rule is enforced alongside eight other constraints that live in
 * the program's own bytecode, so no operator, backend or executor can skip one.
 *
 * Values are read from this vault's live config. The ceilings are the compiled
 * constants in `programs/vault/src/constants.rs`, so a user cannot set a limit
 * looser than the program will accept.
 */
function Guardrails({
  limits,
}: {
  limits: ReturnType<typeof useVaultStore>["limits"];
}) {
  /* With no wallet there is no vault to read, so fall back to the program's
     own defaults rather than a column of dashes — nine dashes made a real
     enforcement stack look like an unimplemented one. The header says which
     is being shown. */
  const l = limits ?? DEFAULT_LIMITS;
  const live = limits !== null;
  const pct = (bps: number | undefined) =>
    bps === undefined ? "—" : `${(bps / 100).toFixed(2)}%`;

  const rows = [
    {
      k: "Trade size",
      v: pct(l.sizeBps),
      ceiling: "≤ 100%",
      why: "Share of the spendable balance committed per entry.",
      on: true,
    },
    {
      k: "Per-trade cap",
      v: pct(l.maxTradeBps),
      ceiling: "≤ 50%",
      why: "A hard ceiling on one trade, above the size rule. Entries only — a stop always sells the whole position.",
      on: true,
    },
    {
      k: "Concentration",
      v: "vault setting",
      ceiling: "—",
      why: "Bounds the sum of entries, not just one. A rule like “buy below $150” keeps firing all the way down; without this a falling market converts the whole vault.",
      on: true,
    },
    {
      k: "Slippage floor",
      v: pct(l.maxSlippageBps),
      ceiling: "≤ 5%",
      why: "Minimum output, derived from the oracle at execution time rather than from the quote the executor supplied.",
      on: true,
    },
    {
      k: "Cooldown",
      v: `${l.cooldownSeconds}s`,
      ceiling: "—",
      why: "Minimum gap between trades. Entries only: suppressing an exit during a cooldown would disarm the stop.",
      on: true,
    },
    {
      k: "Oracle staleness",
      v: `${l.maxOracleStalenessSec}s`,
      ceiling: "≤ 30s",
      why: "A price older than this cannot influence anything. Devnet often publishes slower than the limit, and the program simply refuses.",
      on: true,
    },
    {
      k: "Oracle confidence",
      v: pct(l.maxConfBps),
      ceiling: "≤ 1%",
      why: "Pyth publishes a confidence interval. Too wide and the price is refused rather than traded on.",
      on: true,
    },
    {
      k: "Decision drift",
      v: pct(l.maxOracleDeviationBps),
      ceiling: "≤ 10%",
      why: "How far the market may move between the computation deciding and the trade filling. Entries only, and only against a rising price.",
      on: true,
    },
    {
      k: "Daily loss limit",
      v: pct(l.dailyLossLimitBps),
      ceiling: "—",
      why: "Stored and read by no instruction. Realised P&L needs a cost basis, and measuring it would put the oracle on the withdraw path — which must keep working when everything else is down.",
      on: false,
    },
  ];

  return (
    <div className="overflow-hidden rounded-[14px] border-[3px] border-[var(--color-stroke)]">
      <div className="border-b border-[var(--color-stroke)] bg-[var(--color-void)] px-4 py-2">
        <span className="mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-3)]">
          {live
            ? "this vault's live settings · ceilings compiled into the program"
            : "program defaults shown — connect a wallet to read this vault's own settings"}
        </span>
      </div>
      {rows.map((r, i) => (
        <div
          key={r.k}
          className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,150px)_92px_1fr]"
          style={{
            borderTop: i ? "1px solid var(--color-stroke)" : undefined,
            background: r.on
              ? i % 2
                ? "color-mix(in srgb, var(--color-void) 40%, transparent)"
                : undefined
              : "color-mix(in srgb, var(--color-amber) 8%, transparent)",
          }}
        >
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{
                background: r.on ? "var(--color-up)" : "var(--color-amber)",
              }}
            />
            <span className="text-[15px] font-medium">{r.k}</span>
          </span>
          <span className="tabular flex items-baseline gap-2 text-[15px]">
            <span style={{ color: r.on ? "var(--color-cyan)" : "var(--color-amber)" }}>
              {r.v}
            </span>
            {r.ceiling !== "—" ? (
              <span className="mono text-[11px] text-[var(--color-text-3)]">
                {r.ceiling}
              </span>
            ) : null}
          </span>
          <span className="text-[13px] leading-snug text-[var(--color-text-2)]">
            {r.why}
            {!r.on ? (
              <span className="mono ml-2 uppercase tracking-[0.1em] text-[var(--color-amber)]">
                — not enforced
              </span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function StrategyStudio() {
  const s = useVaultStore();
  const sizeCap = s.limits?.maxTradeBps ?? 1_000;
  const spot = s.oracle?.price ?? null;

  const [draft, setDraft] = useState<Strategy>(() => s.draft ?? emptyStrategy());
  const [mode, setMode] = useState<"price" | "percent">("price");
  const [tfIdx, setTfIdx] = useState(DEFAULT_TIMEFRAME);
  const [hover, setHover] = useState<Hover>(null);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [touched, setTouched] = useState(false);
  const [startQuote, setStartQuote] = useState("1000");
  const [costBps, setCostBps] = useState("30");

  const errors = useMemo(() => validateStrategy(draft, sizeCap), [draft, sizeCap]);
  const errorFor = (f: string) =>
    touched ? errors.find((e) => e.field === f)?.message : undefined;

  const value = (kind: RuleKind) =>
    draft.rules.find((r) => r.kind === kind)?.value ?? "";
  const num = (kind: RuleKind) => {
    const raw = value(kind);
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
  };

  function setRule(kind: RuleKind, raw: string) {
    setDraft((d) => {
      const rest = d.rules.filter((r) => r.kind !== kind);
      const next = raw.trim() === "" ? rest : [...rest, { kind, value: raw }];
      next.sort(
        (a, b) =>
          KINDS.findIndex((k) => k.kind === a.kind) -
          KINDS.findIndex((k) => k.kind === b.kind)
      );
      return { ...d, rules: next };
    });
  }

  /**
   * Percent mode is a lens over the same absolute number: what is stored,
   * encrypted and compared is always the price, never the percentage. The
   * circuit has no access to spot, so a percentage could not be evaluated even
   * if it were sent.
   */
  function setPercent(kind: RuleKind, pctText: string) {
    if (spot === null) return;
    if (pctText.trim() === "") return setRule(kind, "");
    const n = Number(pctText);
    if (!Number.isFinite(n)) return;
    setRule(kind, (spot * (1 + n / 100)).toFixed(2));
  }
  const percentOf = (kind: RuleKind) => {
    const v = num(kind);
    if (v === null || spot === null || spot === 0) return "";
    return (((v - spot) / spot) * 100).toFixed(2);
  };

  function applyPreset(p: (typeof PRESETS)[number]) {
    if (spot === null) return;
    const rules = (["entry", "exit", "stop"] as RuleKind[])
      .filter((k) => p.offsets[k] !== undefined)
      .map((k) => ({
        kind: k,
        value: (spot * (1 + p.offsets[k]! / 100)).toFixed(2),
      }));
    setDraft((d) => ({
      name: d.name.trim() || p.name,
      rules,
      sizeBps: Math.min(p.sizeBps, sizeCap),
    }));
  }

  useEffect(() => {
    let alive = true;
    setCandles(null);
    fetchCandles(TRADABLE.id, TIMEFRAMES[tfIdx], 400)
      .then((c) => alive && setCandles(c))
      .catch(() => alive && setCandles([]));
    return () => {
      alive = false;
    };
  }, [tfIdx]);

  const series = useMemo(
    () => (candles ?? []).map((c) => ({ t: c.t, price: c.c })),
    [candles]
  );

  /* ------------------------------------------------------------ backtest */

  /**
   * Runs the same decision the circuit runs.
   *
   * `runBacktest` mirrors `evaluate_strategy_v3` and `execute_trade` statement
   * for statement and is tested against them, so what this shows is the
   * strategy that would actually be deployed — not a friendlier version of it.
   * It re-runs as you edit, which is the whole reason it is on this page rather
   * than behind a button on another one.
   */
  const sim: BacktestResult | null = useMemo(() => {
    if (series.length === 0) return null;
    // A missing name should not blank the simulation — it is not part of the
    // decision. Every other error means the numbers cannot be trusted.
    if (errors.some((e) => e.field !== "name")) return null;
    const px = (kind: RuleKind, fallback: bigint) => {
      const raw = value(kind);
      return raw.trim() === "" ? fallback : (toPriceUnits(raw) ?? fallback);
    };
    try {
      return runBacktest(
        series,
        {
          entryBelow: px("entry", NEVER_BUY),
          exitAbove: px("exit", NEVER_SELL),
          stopBelow: px("stop", NO_STOP),
          sizeBps: draft.sizeBps,
        },
        {
          maxTradeBps: sizeCap,
          cooldownSeconds: s.limits?.cooldownSeconds ?? 60,
          costBps: Math.max(0, Math.round(Number(costBps) || 0)),
        },
        Math.max(1, Number(startQuote) || 1_000)
      );
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, draft, errors, sizeCap, s.limits?.cooldownSeconds, costBps, startQuote]);

  /* ---------------------------------------------------------- live risk */

  const entry = num("entry");
  const exit = num("exit");
  const stop = num("stop");
  const rr =
    entry !== null && exit !== null && stop !== null && entry > stop
      ? (exit - entry) / (entry - stop)
      : null;

  const stake = s.vaultUsdc !== null ? (s.vaultUsdc * draft.sizeBps) / 10_000 : null;
  const riskPerTrade =
    stake !== null && entry !== null && stop !== null && entry > 0
      ? stake * ((entry - stop) / entry)
      : null;

  const distance = (v: number | null) =>
    v === null || spot === null || spot === 0 ? null : ((v - spot) / spot) * 100;

  const marks = useMemo(
    () =>
      KINDS.map((k) => ({
        price: num(k.kind) ?? 0,
        color: k.color,
        label: k.label,
        title: k.kind === "entry" ? "buy" : k.kind === "exit" ? "sell" : "stop",
      })).filter((b) => b.price > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft]
  );

  const armed = s.mxeVersion > 0;
  const working = s.busy.encrypting || s.busy.converting;

  /* ------------------------------------------------------------- curves */

  /**
   * The equity curve and buy-and-hold on ONE pair of axes.
   *
   * Buy-and-hold is derived from the same price points the simulation walked,
   * rebased to the same starting balance, so the two lines are directly
   * comparable rather than two differently-scaled shapes. Both feed the shared
   * y-domain; neither is normalised to flatter the other.
   */
  const curve = useMemo(() => {
    if (!sim || sim.equity.length < 2) return null;
    const eq = sim.equity;
    const priceAt = new Map(series.map((p) => [p.t, p.price] as const));
    const base = priceAt.get(eq[0].t) ?? series[0]?.price ?? 0;
    if (!(base > 0)) return null;

    const hold = eq.map(
      (e) => sim.startValue * ((priceAt.get(e.t) ?? base) / base)
    );
    const all = [...eq.map((e) => e.value), ...hold];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const span = hi - lo || 1;
    const min = lo - span * 0.08;
    const max = hi + span * 0.08;

    const x = (i: number) => (i / (eq.length - 1)) * CURVE_W;
    const y = (v: number) => CURVE_H - ((v - min) / (max - min)) * CURVE_H;
    const path = (vals: number[]) =>
      vals
        .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
        .join(" ");

    const line = path(eq.map((e) => e.value));
    const idx = new Map(eq.map((e, i) => [e.t, i] as const));

    return {
      line,
      area: `${line} L${CURVE_W},${CURVE_H} L0,${CURVE_H} Z`,
      hold: path(hold),
      // Percentages, so the markers can be plain positioned dots: a circle
      // inside a preserveAspectRatio="none" viewBox renders as an ellipse.
      markers: sim.trades.flatMap((t) => {
        const i = idx.get(t.t);
        if (i === undefined) return [];
        return [
          {
            key: `${t.t}-${i}`,
            x: (i / (eq.length - 1)) * 100,
            y: (y(eq[i].value) / CURVE_H) * 100,
            // Not pos/neg for the two sides: pos and neg mean a number went up
            // or down. An entry is neither, so it takes the accent.
            color:
              t.side === 1
                ? "var(--color-signal-hi)"
                : t.reason === "stop"
                  ? "var(--color-neg)"
                  : "var(--color-pos)",
          },
        ];
      }),
    };
  }, [sim, series]);

  /* --------------------------------------------------------------- seal */

  /**
   * The three integers that actually get encrypted, and whether each one is
   * still the value that was sealed.
   *
   * `sealed` is written by the effect below when `submitted` flips — that is,
   * when the real submission transaction resolves. Nothing here runs on a
   * timer. Editing a threshold afterwards makes it stop matching, and the row
   * unseals, because that value is no longer the one on chain.
   */
  const encrypted = useMemo(
    () =>
      (
        [
          ["entry_below", "entry", NEVER_BUY],
          ["exit_above", "exit", NEVER_SELL],
          ["stop_below", "stop", NO_STOP],
        ] as const
      ).map(([field, kind, fallback]) => {
        const raw = value(kind);
        const v = raw.trim() === "" ? fallback : (toPriceUnits(raw) ?? fallback);
        return { field, v: v.toString() };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft]
  );

  const [sealed, setSealed] = useState<string[] | null>(null);
  const wasSubmitted = useRef(s.submitted);
  useEffect(() => {
    if (s.submitted && !wasSubmitted.current) setSealed(encrypted.map((e) => e.v));
    wasSubmitted.current = s.submitted;
  }, [s.submitted, encrypted]);

  /*
   * There is deliberately no wallet gate on this page.
   *
   * Everything the studio does up to the moment of arming — the chart, the
   * presets computed off live spot, the risk panel, and the simulation that
   * runs the circuit's own decision function — needs only public data. Gating
   * all of it behind a signature replaced a working tool with a box, which is
   * exactly the failure this redesign exists to remove. The signature is
   * required to derive the encryption key, so it gates the ARM ACTION, and the
   * button below says so.
   */

  const ret = sim?.returnPct ?? null;
  const retColor =
    ret === null || ret >= 0 ? "var(--color-pos)" : "var(--color-neg)";

  return (
    <>
      <PageHead
        title="Strategy studio"
        subtitle="Design it, simulate it against the real circuit, then encrypt it"
        actions={
          armed ? (
            <Badge tone="shielded" dot>
              Armed v{s.mxeVersion}
            </Badge>
          ) : s.submitted ? (
            <Badge tone="warn">Saved, not armed</Badge>
          ) : null
        }
      />

      <Reveal
        as="div"
        className="ledger xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
      >
        {/* ============================================ left: the inputs */}
        <div className="grid gap-px bg-[var(--color-rule)]">
          <Block prov="public">
            <BlockHead
              title={TRADABLE.label}
              hint="Your levels drawn on the display feed as price lines. The candles are context; the program acts on the on-chain price account."
              right={
                <div className="flex flex-wrap gap-0.5">
                  {TIMEFRAMES.map((t, i) => (
                    <button
                      key={t.label}
                      onClick={() => setTfIdx(i)}
                      className={`relative rounded-[4px] px-2.5 py-1 text-caption transition-colors ${
                        i === tfIdx
                          ? "text-[var(--color-on-signal)]"
                          : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
                      }`}
                    >
                      {i === tfIdx ? (
                        <motion.span
                          aria-hidden
                          layoutId="tf-pill"
                          transition={SPRINGS.snap}
                          className="absolute inset-0 rounded-[4px] bg-[var(--color-signal)]"
                        />
                      ) : null}
                      <span className="relative">{t.label}</span>
                    </button>
                  ))}
                </div>
              }
            />
            <div className="mb-2">
              <OhlcLegend
                hover={hover}
                latest={candles && candles.length ? candles[candles.length - 1] : null}
              />
            </div>
            {candles === null ? (
              /* The chart's own rules, drawn faint — not a grey pulsing slab.
                 What is loading is a price chart, so the placeholder is one. */
              <div
                aria-hidden
                className="flex h-[300px] flex-col justify-between opacity-30"
              >
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-px bg-[var(--color-rule-strong)]" />
                ))}
              </div>
            ) : (
              <Terminal
                candles={candles}
                overlays={[]}
                studies={[]}
                marks={marks}
                height={300}
                onHover={setHover}
              />
            )}
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--color-rule)] pt-4 text-caption">
              <Prov tone="public">Exposed · public price data</Prov>
              <span className="text-[var(--color-ink-soft)]">
                Spot{" "}
                <span className="tabular text-[var(--color-ink)]">
                  {spot === null ? "—" : `$${money(spot)}`}
                </span>
              </span>
              {KINDS.map((k) => {
                const level = num(k.kind);
                const d = distance(level);
                return (
                  <span key={k.kind} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-[2px] w-3"
                      style={{ background: k.color }}
                    />
                    <span className="text-[var(--color-ink-soft)]">{k.label}</span>
                    <span className="tabular">
                      {level === null
                        ? "off"
                        : d === null
                          ? `$${fmtPrice(level)}`
                          : `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`}
                    </span>
                  </span>
                );
              })}
            </div>
          </Block>

          {/* -------------------------------------------------- presets */}
          <Block>
            <BlockHead
              title="Start from a shape"
              hint="Offsets from the current price. Not signals — the circuit has no notion of trend or volatility."
            />
            <div className="grid gap-2 sm:grid-cols-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => applyPreset(p)}
                  disabled={spot === null}
                  className="rounded-[4px] border border-[var(--color-rule-strong)] p-4 text-left transition-colors hover:bg-[var(--color-panel)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <div className="font-medium">{p.name}</div>
                  <div className="mt-1 text-caption text-[var(--color-ink-soft)]">
                    {p.blurb}
                  </div>
                </button>
              ))}
            </div>
          </Block>

          {/* ----------------------------------------------- the guardrails
              The answer to "isn't this just a limit order?".

              A limit order is one comparison: fill at price. This vault runs a
              stack of checks on chain before any fill can happen, and every one
              of them is in the deployed program rather than in a backend that
              could be asked nicely to skip it. The values are read live from
              this vault's own config — nothing here is illustrative.

              `daily_loss_limit_bps` is listed and marked NOT ENFORCED. Hiding
              it would make the other eight less believable, and the program's
              own comment explains at length why it cannot be measured without
              putting the oracle on the withdraw path. */}
          <Block>
            <BlockHead
              eyebrow="Exposed · enforced on chain"
              title="What the program checks before any fill"
              hint="A limit order is one comparison. This is the stack that runs on every trade, in the deployed program — not in a backend."
            />
            <Guardrails limits={s.limits} />
          </Block>

          {/* --------------------------------------------------- inputs */}
          <Block>
            <BlockHead
              title="Levels"
              hint="Leave a field blank to switch that rule off."
              right={
                <div className="flex gap-0.5">
                  {(["price", "percent"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      disabled={m === "percent" && spot === null}
                      className={`relative rounded-[4px] px-2.5 py-1 text-caption transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        mode === m
                          ? "text-[var(--color-ink)]"
                          : "text-[var(--color-ink-faint)]"
                      }`}
                    >
                      {mode === m ? (
                        <motion.span
                          aria-hidden
                          layoutId="mode-pill"
                          transition={SPRINGS.snap}
                          className="absolute inset-0 rounded-[4px] bg-[var(--color-hover)]"
                        />
                      ) : null}
                      <span className="relative">
                        {m === "price" ? "USD" : "% from spot"}
                      </span>
                    </button>
                  ))}
                </div>
              }
            />

            <div className="mb-7">
              <label htmlFor="sname" className="mb-2 block">
                <Eyebrow>Name</Eyebrow>
              </label>
              <input
                id="sname"
                className="field"
                placeholder="Range trade"
                maxLength={MAX_NAME_LENGTH + 10}
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
              {errorFor("name") ? (
                <p className="mt-2 text-caption text-[var(--color-neg)]">
                  {errorFor("name")}
                </p>
              ) : null}
            </div>

            <div className="space-y-3">
              {KINDS.map((k) => {
                const on = num(k.kind) !== null;
                const err = errorFor(k.kind);
                return (
                  <div
                    key={k.kind}
                    className="rounded-[4px] border border-[var(--color-rule)] p-4"
                    style={
                      on
                        ? {
                            borderColor: `color-mix(in srgb, ${k.color} 35%, transparent)`,
                          }
                        : undefined
                    }
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{
                          background: on ? k.color : "var(--color-rule-strong)",
                        }}
                      />
                      <label
                        htmlFor={`r-${k.kind}`}
                        className="w-[104px] shrink-0 font-medium"
                      >
                        {k.label}
                      </label>
                      <span className="tabular shrink-0 text-caption text-[var(--color-ink-faint)]">
                        {k.op}
                      </span>
                      <div className="relative min-w-[120px] flex-1">
                        <input
                          id={`r-${k.kind}`}
                          className="field tabular pr-12"
                          inputMode="decimal"
                          placeholder={mode === "price" ? "—" : "0.0"}
                          value={mode === "price" ? value(k.kind) : percentOf(k.kind)}
                          onChange={(e) =>
                            mode === "price"
                              ? setRule(k.kind, e.target.value)
                              : setPercent(k.kind, e.target.value)
                          }
                        />
                        <span className="tabular pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-caption text-[var(--color-ink-faint)]">
                          {mode === "price" ? "USD" : "%"}
                        </span>
                      </div>
                      <span className="tabular w-[104px] shrink-0 whitespace-nowrap text-right text-caption text-[var(--color-ink-faint)]">
                        {on ? `→ ${k.action}` : "off"}
                      </span>
                    </div>
                    <p className="mt-2 text-caption text-[var(--color-ink-soft)] sm:ml-[132px]">
                      {mode === "percent" && on
                        ? `= $${money(num(k.kind)!)} · ${k.hint}`
                        : k.hint}
                    </p>
                    {err ? (
                      <p className="mt-1.5 text-caption text-[var(--color-neg)] sm:ml-[132px]">
                        {err}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {errorFor("rules") ? (
              <p className="mt-3 text-caption text-[var(--color-neg)]">
                {errorFor("rules")}
              </p>
            ) : null}

            <div className="mt-7 border-t border-[var(--color-rule)] pt-6">
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <Eyebrow>Size per trade</Eyebrow>
                <span className="tabular text-title">
                  {(draft.sizeBps / 100).toFixed(0)}%
                </span>
              </div>
              <input
                type="range"
                min={100}
                max={sizeCap}
                step={100}
                value={Math.min(draft.sizeBps, sizeCap)}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, sizeBps: Number(e.target.value) }))
                }
                className="w-full accent-[var(--color-signal)]"
                aria-label="Size per trade"
              />
              <p className="mt-3 text-caption text-[var(--color-ink-soft)]">
                Share of the spendable balance committed per entry. Your vault
                caps this at {sizeCap / 100}%
                {stake !== null
                  ? ` — about ${money(stake)} ${QUOTE_SYMBOL} at today's balance`
                  : ""}
                . A stop always sells the whole position regardless.
              </p>
              {errorFor("sizeBps") ? (
                <p className="mt-2 text-caption text-[var(--color-neg)]">
                  {errorFor("sizeBps")}
                </p>
              ) : null}
            </div>
          </Block>

          {/* ---------------------------------------- what gets encrypted
              Directly under the levels it mirrors, rather than in the far
              column: these are the same three numbers, in circuit units. */}
          <Block prov="private">
            <BlockHead
              title="What gets encrypted"
              right={<Prov tone="private">Shielded · in MPC</Prov>}
            />
            {errors.some((e) => e.field !== "name") ? (
              <p className="text-caption text-[var(--color-ink-soft)]">
                Finish the rules to see it.
              </p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3">
                {encrypted.map((e, i) => (
                  <div key={e.field} className="contents">
                    <dt className="u-label">
                      {e.field}
                    </dt>
                    <dd className="justify-self-end text-right">
                      <Seal
                        value={e.v}
                        done={sealed?.[i] === e.v}
                        label="encrypted in this browser"
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="mt-5 text-caption text-[var(--color-ink-soft)]">
              Three integers, fixed width. A rule you switched off still occupies
              its slot with a value that can never match, so an observer cannot
              tell which rules you use.
            </p>
            <p className="mt-3 text-caption text-[var(--color-exposed)]">
              Your trade size is <strong>not</strong> in here. The traded amount
              and your vault balance are both public in the same transaction, so
              dividing one by the other recovers the size exactly — the first time
              you trade. It is stored in the clear, in your vault settings.
            </p>
          </Block>
        </div>

        {/* ========================================== right: the outcome */}
        <div className="flex flex-col">
          <div className="grid flex-1 gap-px bg-[var(--color-rule)]">
            <Block>
              <BlockHead
                title="Simulation"
                hint="Runs the same decision function as the circuit, over the window above, re-running as you type."
              />

              {sim === null ? (
                <p className="text-caption text-[var(--color-ink-soft)]">
                  {series.length === 0
                    ? "Loading price history…"
                    : "Add at least one valid rule to simulate."}
                </p>
              ) : (
                <>
                  <div className="relative">
                    <div className="pointer-events-none absolute left-0 top-0 z-10">
                      <div className="u-label">
                        Simulated return
                      </div>
                      <div
                        className="tabular mt-2 text-figure"
                        style={{ color: retColor }}
                      >
                        {/* `money`: critically damped. A spring that overshoots
                            shows a return that was never simulated. */}
                        <Ticking value={ret} kind="money" format={pct} />
                      </div>
                    </div>

                    {curve ? (
                      <>
                        <svg
                          viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
                          preserveAspectRatio="none"
                          className="w-full"
                          style={{ height: CURVE_H }}
                          role="img"
                          aria-label={`Simulated equity ${pct(sim.returnPct)} against buy and hold ${pct(sim.holdReturnPct)} over the same window`}
                        >
                          <defs>
                            <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={retColor} stopOpacity="0.22" />
                              <stop offset="100%" stopColor={retColor} stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <path d={curve.area} fill="url(#eq-fill)" />
                          <path
                            d={curve.hold}
                            fill="none"
                            stroke="var(--color-ink-faint)"
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                          />
                          <path
                            d={curve.line}
                            fill="none"
                            stroke={retColor}
                            strokeWidth="1.75"
                            vectorEffect="non-scaling-stroke"
                          />
                        </svg>
                        {curve.markers.map((m) => (
                          <span
                            key={m.key}
                            aria-hidden
                            className="absolute h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                            style={{
                              left: `${m.x}%`,
                              top: `${m.y}%`,
                              background: m.color,
                            }}
                          />
                        ))}
                      </>
                    ) : null}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-[var(--color-ink-soft)]">
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="h-[2px] w-4"
                        style={{ background: retColor }}
                      />
                      This strategy
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="h-px w-4 bg-[var(--color-ink-faint)]"
                      />
                      Buy &amp; hold, same axes
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 rounded-full bg-[var(--color-signal-hi)]"
                      />
                      entry
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 rounded-full bg-[var(--color-pos)]"
                      />
                      take-profit
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 rounded-full bg-[var(--color-neg)]"
                      />
                      stop
                    </span>
                  </div>

                  <div className="mt-6">
                    <Row
                      label="Buy & hold, same window"
                      value={
                        <span
                          style={{
                            color:
                              sim.holdReturnPct >= 0
                                ? "var(--color-pos)"
                                : "var(--color-neg)",
                          }}
                        >
                          {pct(sim.holdReturnPct)}
                        </span>
                      }
                    />
                    <Row
                      label="Max drawdown"
                      value={`${sim.maxDrawdownPct.toFixed(1)}%`}
                    />
                    <Row
                      label="Fills"
                      value={`${sim.trades.length} · ${sim.wins}W/${sim.losses}L`}
                    />
                  </div>

                  {sim.skipped.length > 0 ? (
                    <div className="mt-6 border border-[var(--color-rule)] p-4">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge tone="warn">{sim.skipped.length} blocked</Badge>
                        <span className="text-caption text-[var(--color-ink-soft)]">
                          decisions your own limits refused
                        </span>
                      </div>
                      <ul className="tabular space-y-1 text-caption text-[var(--color-ink-soft)]">
                        {Object.entries(
                          sim.skipped.reduce<Record<string, number>>((acc, k) => {
                            acc[k.reason] = (acc[k.reason] ?? 0) + 1;
                            return acc;
                          }, {})
                        ).map(([reason, n]) => (
                          <li key={reason}>
                            {n}× {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {sim.trades.length > 0 ? (
                    <div className="mt-6 max-h-64 overflow-y-auto border-y border-[var(--color-rule)]">
                      <table className="w-full text-caption">
                        <thead className="sticky top-0 bg-[var(--color-paper)]">
                          <tr className="border-b border-[var(--color-rule)]">
                            <th className="u-label px-3 py-2 text-left">
                              When
                            </th>
                            <th className="u-label px-3 py-2 text-left">
                              Reason
                            </th>
                            <th className="u-label px-3 py-2 text-right">
                              Price
                            </th>
                            <th className="u-label px-3 py-2 text-right">
                              In
                            </th>
                          </tr>
                        </thead>
                        <tbody className="tabular divide-y divide-[var(--color-rule)]">
                          {sim.trades.map((t, i) => (
                            <tr key={`${t.t}-${i}`}>
                              <td className="px-3 py-2 text-[var(--color-ink-soft)]">
                                {new Date(t.t * 1000).toLocaleDateString()}
                              </td>
                              <td
                                className="px-3 py-2"
                                style={{
                                  color:
                                    t.side === 1
                                      ? "var(--color-signal-hi)"
                                      : t.reason === "stop"
                                        ? "var(--color-neg)"
                                        : "var(--color-pos)",
                                }}
                              >
                                {t.reason}
                              </td>
                              <td className="px-3 py-2 text-right">${money(t.price)}</td>
                              <td className="px-3 py-2 text-right text-[var(--color-ink-soft)]">
                                {money(t.amountIn, t.side === 1 ? 2 : 4)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </>
              )}

              <div className="mt-6 border-t border-[var(--color-rule)] pt-6">
                <div className="mb-3">
                  <Eyebrow>Assumptions</Eyebrow>
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="text-caption">
                    <span className="text-[var(--color-ink-soft)]">
                      Starting {QUOTE_SYMBOL}
                    </span>
                    <input
                      className="field tabular mt-1.5 w-32"
                      inputMode="decimal"
                      value={startQuote}
                      onChange={(e) => setStartQuote(e.target.value)}
                    />
                  </label>
                  <label className="text-caption">
                    <span className="text-[var(--color-ink-soft)]">
                      Cost per fill (bps)
                    </span>
                    <input
                      className="field tabular mt-1.5 w-32"
                      inputMode="decimal"
                      value={costBps}
                      onChange={(e) => setCostBps(e.target.value)}
                    />
                  </label>
                </div>
                <p className="mt-4 text-caption text-[var(--color-ink-soft)]">
                  Not modelled, because modelling it badly would be worse than
                  leaving it out: order-book impact, MEV, Jupiter&rsquo;s routing,
                  and the ~72-slot gap between a decision and its execution. Past
                  prices are not a forecast.
                </p>
              </div>
            </Block>

            <Block>
              <BlockHead title="Risk on this shape" />
              <div>
                <Row
                  label="Reward / risk"
                  value={rr === null ? "—" : `${rr.toFixed(2)} : 1`}
                />
                <Row
                  label="Stake per entry"
                  value={stake === null ? "—" : `${money(stake)} ${QUOTE_SYMBOL}`}
                />
                <Row
                  label="Loss if stopped"
                  value={
                    riskPerTrade === null
                      ? "—"
                      : `≈ ${money(riskPerTrade)} ${QUOTE_SYMBOL}`
                  }
                />
                <Row
                  label="Cooldown"
                  value={`${s.limits?.cooldownSeconds ?? 60}s`}
                  hint="entries"
                />
              </div>
              <p className="mt-5 text-caption text-[var(--color-ink-soft)]">
                &ldquo;Loss if stopped&rdquo; assumes the stop fills at its level. A
                gap through it fills lower, and slippage is charged on top — your
                max-slippage limit bounds that, it does not remove it.
              </p>
            </Block>

            <Block>
              <BlockHead
                title="Arm it"
                hint="Two signatures: encrypt, then hand to the cluster."
              />

              {/* Alert declares an exit; without a presence boundary it never
                  ran, so a resolved error vanished between two frames. */}
              <AnimatePresence initial={false}>
                {s.actionError ? (
                  <div key="err" className="mb-4">
                    <Alert tone="bad">{s.actionError}</Alert>
                  </div>
                ) : null}
                {s.mxe && !s.mxe.live ? (
                  <div key="mxe" className="mb-4">
                    <Alert tone="warn" title="Blocked.">
                      {s.mxe.reason} Submitting now would encrypt to a public
                      development key, so this refuses rather than pretending.
                    </Alert>
                  </div>
                ) : null}
                {s.submitted && !armed && !working ? (
                  <div key="unarmed" className="mb-4">
                    <Alert tone="warn" title="Saved but not armed.">
                      The cluster has not re-encrypted this strategy to itself yet, so
                      evaluations are refused and it cannot trade. Only you can
                      complete this step — save again to retry.
                    </Alert>
                  </div>
                ) : null}
              </AnimatePresence>

              <ol className="space-y-4">
                {[
                  {
                    n: "1",
                    t: "Encrypted in this browser",
                    d: "The plaintext never leaves this tab. Only ciphertext is sent.",
                    done: s.submitted,
                    now: s.busy.encrypting,
                  },
                  {
                    n: "2",
                    t: "Re-encrypted to the cluster",
                    d: "What lets evaluations run with nobody online.",
                    done: armed,
                    now: s.busy.converting,
                  },
                ].map((step) => (
                  <li key={step.n} className="flex gap-3">
                    <span
                      className="tabular mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-caption"
                      style={{
                        borderColor: step.done
                          ? "var(--color-shielded)"
                          : "var(--color-rule-strong)",
                        color: step.done
                          ? "var(--color-shielded)"
                          : "var(--color-ink-faint)",
                      }}
                    >
                      {step.done ? "✓" : step.n}
                    </span>
                    <div>
                      <div>
                        {step.t}
                        {step.now ? (
                          <span className="ml-2 text-caption text-[var(--color-signal-hi)]">
                            working…
                          </span>
                        ) : null}
                      </div>
                      <div className="text-caption text-[var(--color-ink-soft)]">
                        {step.d}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>

              {armed ? (
                <p className="mt-5 text-caption text-[var(--color-ink-soft)]">
                  Arming a replacement retires the current one first: the old
                  converted copy is zeroed on chain before the new one is converted,
                  so the two can never both be live.
                </p>
              ) : null}
            </Block>
          </div>

          {/* The terminus. It follows you down the column rather than sitting
              after four hundred words of explanation. */}
          <div className="sticky bottom-0 z-20 border-t border-[var(--color-rule)] bg-[var(--color-paper)] p-[var(--space-2)]">
            <button
              className="btn btn-primary btn-xl w-full"
              disabled={working || !s.connected || !s.vaultStatus}
              onClick={() => {
                setTouched(true);
                if (errors.length > 0) return;
                s.setDraft(draft);
                void s.submitStrategy(draft, sizeCap);
              }}
            >
              {!s.connected
                ? "Connect a wallet to arm this"
                : s.busy.encrypting
                ? "Encrypting…"
                : s.busy.converting
                  ? "Handing to the cluster…"
                  : armed
                    ? "Replace the armed strategy"
                    : "Encrypt & arm"}
            </button>
            {!s.connected ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-caption text-[var(--color-ink-soft)]">
                  The encryption key is derived from a wallet signature, so a
                  strategy cannot be armed without one. Everything above works
                  without it.
                </p>
                <WalletButton />
              </div>
            ) : !s.vaultStatus ? (
              <p className="mt-3 text-caption text-[var(--color-ink-soft)]">
                Create a vault first —{" "}
                <Link href="/app" className="underline underline-offset-2">
                  Overview
                </Link>
                .
              </p>
            ) : null}
            {touched && errors.length > 0 ? (
              <p className="mt-3 text-caption text-[var(--color-neg)]">
                {errors.length} thing{errors.length > 1 ? "s" : ""} to fix above.
              </p>
            ) : null}
          </div>
        </div>
      </Reveal>
    </>
  );
}
