"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Machine } from "@/components/machine";
import { useOraclePrice } from "@/lib/oracle-feed";

/**
 * The landing page.
 *
 * Written against one rule: a judge with forty submissions open gives this
 * thirty seconds, and in the first ten must understand that it is a trading bot
 * whose numbers are hidden. So the explanation is an animation, not a paragraph.
 * Total body prose on the page is about two hundred words and no paragraph runs
 * longer than two lines.
 *
 * **No animation library is imported here.** Everything moves via CSS
 * keyframes, transitions and `animation-timeline: view()`. That is the whole
 * performance story: `motion` and the Solana wallet stack are both confined to
 * `/app`, so this page ships a fraction of what it used to.
 *
 * **Two colour meanings are load-bearing.** Cyan is PUBLIC — readable on chain
 * by anyone. Magenta is HIDDEN — never leaves the computation. Amber is UNKNOWN
 * or caution. A hidden value is never rendered as legible digits anywhere on
 * this page; it is always a padlock pill. The moment one is printed, the colour
 * grammar stops meaning anything.
 *
 * **Every qualifier is a child of the claim it qualifies** (`.ast`). Nothing is
 * deferred to a footer, so a later polish pass cannot quietly drop a caveat
 * without visibly breaking the object it hangs from.
 *
 * Words that appear nowhere here and must never be added: unruggable,
 * invisible, impossible to front-run, completely private, fully private,
 * trustless, zero-knowledge, military-grade, guaranteed, "only your key can
 * withdraw", "nobody can read it" — and any figure shown as a return, a track
 * record or a projection.
 */

const PROGRAM = "J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ";
const ORACLE = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const REPO = "https://github.com/Anshv784/silentedge";

/* ------------------------------------------------------------- live data */

type Bar = { t: number; c: number; h: number; l: number };

function useCandles(resolution: string, seconds: number, bars: number) {
  const [rows, setRows] = useState<Bar[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const to = Math.floor(Date.now() / 1000);
      fetch(
        `/api/candles?symbol=${encodeURIComponent("Crypto.SOL/USD")}&resolution=${resolution}&from=${to - seconds * bars}&to=${to}`
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!alive || !j || j.s !== "ok") return;
          setRows(
            j.t.map((t: number, i: number) => ({
              t,
              c: j.c[i],
              h: j.h[i],
              l: j.l[i],
            }))
          );
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, Math.max(5000, seconds * 1000));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [resolution, seconds, bars]);
  return rows;
}

/* ------------------------------------------------------------- odometer */

/**
 * A price where only the digits that changed move.
 *
 * A whole-number crossfade reads as a flicker; rolling every column reads as a
 * slot machine. Rolling only what changed is what makes a live figure feel like
 * an instrument.
 */
function Odometer({ value }: { value: number | null }) {
  const text = value === null ? "———.——" : value.toFixed(2);
  return (
    <span className="mono tnum inline-flex" style={{ lineHeight: 1 }} aria-label={text}>
      {text.split("").map((ch, i) => {
        if (!/\d/.test(ch)) {
          return (
            <span key={i} aria-hidden>
              {ch}
            </span>
          );
        }
        const d = Number(ch);
        /* The column is exactly one line-box tall and the strip inside it is
           ten of them. `lineHeight: 1` on both is load-bearing: inheriting the
           body's 1.45 makes each digit taller than its own clip window, and
           every numeral spills out of the mask. */
        return (
          <span
            key={i}
            aria-hidden
            style={{
              display: "inline-block",
              height: "1em",
              lineHeight: 1,
              overflow: "hidden",
              verticalAlign: "bottom",
            }}
          >
            <span
              style={{
                display: "block",
                transform: `translateY(-${d}em)`,
                transition: "transform 380ms var(--ease-pop)",
              }}
            >
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <span key={n} style={{ display: "block", height: "1em", lineHeight: 1 }}>
                  {n}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/* ---------------------------------------------------------------- spark */

function Spark({
  rows,
  levels = [],
  height = 60,
}: {
  rows: Bar[] | null;
  levels?: { v: number; color: string }[];
  height?: number;
}) {
  if (!rows || rows.length < 2) return <div style={{ height }} aria-hidden />;
  const W = 600;
  const cs = rows.map((r) => r.c);
  const all = [...cs, ...levels.map((l) => l.v).filter((v) => v > 0)];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo) * 0.12 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const y = (p: number) => height - ((p - min) / (max - min)) * height;
  const x = (i: number) => (i / (cs.length - 1)) * W;
  const d = cs
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p).toFixed(1)}`)
    .join(" ");
  const up = cs[cs.length - 1] >= cs[0];

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      role="img"
      aria-label="SOL price, recent"
    >
      <path
        d={`${d} L${W},${height} L0,${height} Z`}
        fill={up ? "rgba(43,224,138,.14)" : "rgba(255,84,112,.14)"}
      />
      <path
        d={d}
        fill="none"
        stroke={up ? "var(--color-up)" : "var(--color-down)"}
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
      />
      {levels
        .filter((l) => l.v > min && l.v < max)
        .map((l, i) => (
          <line
            key={i}
            x1="0"
            x2={W}
            y1={y(l.v)}
            y2={y(l.v)}
            stroke={l.color}
            strokeWidth="2"
            strokeDasharray="6 5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </svg>
  );
}

/* -------------------------------------------------------------- marquee */

const RAIL = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "SUI", "JUP", "PYTH"];

function Marquee() {
  const [rows, setRows] = useState<{ base: string; last: number; ch: number | null }[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/quotes?symbols=${RAIL.map((b) => `Crypto.${b}/USD`).join(",")}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!alive || !j?.quotes) return;
          setRows(
            RAIL.map((base) => {
              const q = j.quotes[`Crypto.${base}/USD`];
              return q ? { base, last: q.last, ch: q.changePct } : null;
            }).filter(Boolean) as { base: string; last: number; ch: number | null }[]
          );
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (rows.length === 0) return null;
  const run = [...rows, ...rows];

  return (
    <div className="rail overflow-hidden border-y-[3px] border-[var(--color-stroke)] py-2.5">
      <div className="rail-track gap-8">
        {run.map((r, i) => (
          <span
            key={i}
            className="mono flex shrink-0 items-center gap-2 px-1 text-[13px]"
            aria-hidden={i >= rows.length}
          >
            <span className="font-bold text-[var(--color-text-2)]">{r.base}</span>
            <span className="tnum text-[var(--color-text)]">
              {r.last < 1 ? r.last.toFixed(5) : r.last.toFixed(2)}
            </span>
            {r.ch !== null ? (
              <span className={`tnum ${r.ch >= 0 ? "up" : "down"}`}>
                {r.ch >= 0 ? "▲" : "▼"}
                {Math.abs(r.ch).toFixed(2)}%
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- playground */

/**
 * The toy that makes the product concrete.
 *
 * Three sliders over real candles, and a count of how many times those rules
 * would have crossed in the window shown. It is a count of past crossings and
 * it says so — not a backtest, not a return, not a projection.
 *
 * The seal at the end is a demo. Its footnote says exactly that, and the
 * footnote is a child of the seal so it cannot be dropped without visibly
 * breaking it.
 */
function Playground({ spot }: { spot: number | null }) {
  const rows = useCandles("1", 60, 1440);
  const [buy, setBuy] = useState<number | null>(null);
  const [sell, setSell] = useState<number | null>(null);
  const [stop, setStop] = useState<number | null>(null);
  const [sealed, setSealed] = useState(false);
  const [burst, setBurst] = useState(0);
  const prevFires = useRef(0);

  /* Anchor the three levels inside the window actually on screen, not at fixed
     percentages of spot. SOL moved about 2% over the last day, so offsets of
     ±4% put every level outside the data and the toy opened reading "0 times",
     which looks broken. Percentiles of the observed range make the demo start
     alive whatever the market did. */
  useEffect(() => {
    if (!rows || rows.length === 0 || buy !== null) return;
    const sorted = rows.map((r) => r.c).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.floor((sorted.length - 1) * q)];
    setBuy(+at(0.35).toFixed(2));
    setSell(+at(0.75).toFixed(2));
    setStop(+at(0.08).toFixed(2));
  }, [rows, buy]);

  const lo = rows ? Math.min(...rows.map((r) => r.l)) : 0;
  const hi = rows ? Math.max(...rows.map((r) => r.h)) : 1;

  /* A crossing is a bar whose range contains the level — the same comparison
     the circuit makes, counted over the window on screen. It is history, not a
     forecast, and the label under it says so. */
  const fires = useMemo(() => {
    if (!rows || buy === null || sell === null || stop === null) return 0;
    let n = 0;
    for (const r of rows) {
      if (r.l <= buy && buy <= r.h) n++;
      if (r.l <= sell && sell <= r.h) n++;
      if (r.l <= stop && stop <= r.h) n++;
    }
    return n;
  }, [rows, buy, sell, stop]);

  useEffect(() => {
    if (fires > prevFires.current && prevFires.current !== 0) setBurst((b) => b + 1);
    prevFires.current = fires;
  }, [fires]);

  const seal = useCallback(() => {
    setSealed(true);
    setBurst((b) => b + 1);
  }, []);

  const levels =
    buy === null || sell === null || stop === null
      ? []
      : [
          { v: buy, color: "var(--color-cyan)" },
          { v: sell, color: "var(--color-up)" },
          { v: stop, color: "var(--color-down)" },
        ];

  const slider = (
    label: string,
    value: number | null,
    set: (n: number) => void,
    color: string
  ) => (
    <label className="block">
      <span
        className="mono flex items-baseline justify-between text-[11px] uppercase tracking-[0.14em]"
        style={{ color }}
      >
        {label}
        <span className="tnum text-[15px] font-bold text-[var(--color-text)]">
          {value === null ? "—" : value.toFixed(2)}
        </span>
      </span>
      <input
        type="range"
        min={lo}
        max={hi}
        step={0.01}
        value={value ?? lo}
        disabled={!rows || sealed}
        onChange={(e) => set(Number(e.target.value))}
        className="mt-2 w-full"
        style={{ accentColor: color }}
        aria-label={label}
      />
    </label>
  );

  return (
    <div className="slab p-6 sm:p-8">
      <div className="grid gap-7 lg:grid-cols-[minmax(0,300px)_1fr]">
        <div className="relative space-y-5">
          {slider("Buy under", buy, setBuy, "var(--color-cyan)")}
          {slider("Sell over", sell, setSell, "var(--color-up)")}
          {slider("Stop below", stop, setStop, "var(--color-down)")}

          {/* The seal covers the numbers it sealed rather than sitting beside
              them. Once sealed the digits are gone and a padlock pill is what
              remains — the same grammar the app uses. */}
          <div className="frost" data-sealed={sealed ? "1" : "0"} aria-hidden>
            <div className="flex h-full items-center justify-center">
              <span className="hid">
                <LockGlyph /> SEALED
              </span>
            </div>
          </div>
        </div>

        <div>
          <div className="relative overflow-hidden rounded-2xl border-[3px] border-[var(--color-stroke)] bg-[var(--color-void)] p-3">
            <Spark rows={rows} levels={levels} height={150} />
            {burst > 0 ? <Confetti key={burst} /> : null}
          </div>

          <p className="mt-4 font-semibold">
            This rule would have fired{" "}
            <span className="tnum text-[var(--color-lime)]">{fires}</span> times in the
            last 24 hours.
          </p>
          <span className="ast">
            A COUNT OF PAST CROSSINGS IN THE WINDOW SHOWN — NOT A BACKTEST, NOT A
            RETURN, NOT A PROJECTION
          </span>

          <div className="mt-6">
            <button className="btn btn-primary" onClick={seal} disabled={sealed || !rows}>
              {sealed ? "Sealed" : "Seal these numbers"}
            </button>
            {sealed ? (
              <span className="ast">
                DEMO ONLY — THE REAL SEAL IS 3 × 32 BYTES, RESCUECIPHER OVER AN
                X25519 SHARED SECRET, BUILT IN YOUR BROWSER IN THE APP. NO WALLET
                AND NO CHAIN ON THIS PAGE.
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Confetti() {
  const bits = useMemo(
    () =>
      Array.from({ length: 18 }, (_, i) => ({
        cx: `${(i % 2 ? 1 : -1) * (30 + ((i * 37) % 140))}px`,
        cy: `${-40 - ((i * 53) % 110)}px`,
        cr: `${((i * 97) % 360) - 180}deg`,
        color: [
          "var(--color-lime)",
          "var(--color-cyan)",
          "var(--color-magenta)",
          "var(--color-amber)",
        ][i % 4],
        delay: (i % 6) * 18,
      })),
    []
  );
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2" aria-hidden>
      {bits.map((b, i) => (
        <span
          key={i}
          className="absolute block h-2 w-2 rounded-[2px]"
          style={
            {
              background: b.color,
              "--cx": b.cx,
              "--cy": b.cy,
              "--cr": b.cr,
              animation: `confetti 900ms var(--ease-arrive) ${b.delay}ms both`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/* ------------------------------------------------------------ grade rack */

const GRADES = [
  {
    badge: "UNVERIFIED · T-3",
    tone: "var(--color-down)",
    head: "One key can upgrade this program.",
    body: "The upgrade authority is a single hot keypair, Cbdvwy6D…kbpTZ, and every other line on this site is conditional on it.",
    reveal:
      "SECURITY.md, the gaps that matter #1. Verified live, not assumed: solana program show reports that authority and the account is system-owned — a plain keypair, not a multisig.",
  },
  {
    badge: "INHERENT · T-9",
    tone: "var(--color-text-3)",
    head: "Your trades are public.",
    body: "Solana is a public ledger, every fill is a labelled inequality, and enough of them narrow the three prices behind them.",
    reveal:
      "SECURITY.md T-9 — inherent and unfixable. Bounds tighten roughly logarithmically: days, not years, for an active bot. Sharpened by T-38 and T-39. Unread, not unknowable.",
  },
  {
    badge: "CODED · T-7",
    tone: "var(--color-amber)",
    head: "We hold the MXE authority.",
    body: "Using it would halt every bot loudly and publicly on chain and cannot forge a trade, but it could decrypt strategies already stored.",
    reveal:
      "SECURITY.md T-7 — partially mitigated. Cluster pinning makes a migration halt the system loudly. Ciphertext already published on chain stays decryptable, because anything the MXE computes on, the MXE key decrypts, and on-chain data is permanent.",
  },
  {
    badge: "UNVERIFIED · T-10",
    tone: "var(--color-down)",
    head: "We cannot prove one node can’t read your numbers.",
    body: "Arcium’s one-honest-node guarantee is their published property, reproduced here, and nothing in this repo can verify it.",
    reveal:
      "SECURITY.md, what this audit does not cover: the Arcium privacy claim (1-of-n honest) is a vendor property reproduced from their documentation, not something this project can verify. No third party has reviewed any of this.",
  },
];

/* -------------------------------------------------------------- the page */

export function Landing() {
  const oracle = useOraclePrice();
  const stage = useRef<HTMLDivElement>(null);
  const spark = useCandles("5S", 5, 240);

  /* One rAF-throttled pointermove writes two registered custom properties. No
     React state, so the tilt never triggers a render. */
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let queued = false;
    let mx = 0;
    let my = 0;
    const apply = () => {
      queued = false;
      el.style.setProperty("--ry", `${mx * 7}deg`);
      el.style.setProperty("--rx", `${-my * 7}deg`);
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      mx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      my = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      if (!queued) {
        queued = true;
        requestAnimationFrame(apply);
      }
    };
    const leave = () => {
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);

  const age = oracle ? Math.max(0, Math.round(Date.now() / 1000 - oracle.publishedAt)) : null;
  /* 30s is not a design choice — it is MAX_ORACLE_STALENESS_CEILING from
     programs/vault/src/constants.rs. The dot goes amber at exactly the age
     where the deployed program refuses to act on the price, which makes it a
     readout rather than decoration. Devnet's publisher is often slower than
     that, and the caption says so instead of pretending otherwise. */
  const fresh = age !== null && age < 30;
  const change =
    spark && spark.length > 1
      ? ((spark[spark.length - 1].c - spark[0].c) / spark[0].c) * 100
      : null;

  return (
    <div>
      {/* ------------------------------------------------------- top bar */}
      <header
        className="sticky top-0 z-50 border-b-[3px] border-[var(--color-stroke)]"
        style={{
          background: "color-mix(in srgb, var(--color-deep) 88%, transparent)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-3 px-4 sm:px-7">
          <Link href="/" className="flex items-center gap-2.5">
            <Keyhole />
            <span className="mono text-[14px] font-bold tracking-[0.1em]">SILENTEDGE</span>
          </Link>
          <span className="mono tnum ml-3 hidden text-[13px] text-[var(--color-cyan)] sm:inline">
            SOL {oracle ? oracle.price.toFixed(2) : "—"}
          </span>
          <span className="chip chip-amber ml-auto hidden sm:inline-flex">DEVNET</span>
          <Link href="/app/market" className="btn btn-primary btn-sm">
            Open the app
          </Link>
        </div>
      </header>

      {/* ---------------------------------------------------------- hero */}
      <section className="mx-auto max-w-[1240px] px-4 pb-10 pt-12 sm:px-7 sm:pt-16">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(420px,1.05fr)]">
          <div>
            <div className="flex flex-wrap gap-2">
              <span className="chip chip-amber">DEVNET</span>
              <span className="chip chip-amber">UNAUDITED</span>
              <span className="chip chip-amber">UPGRADE KEY: 1</span>
            </div>

            <h1 className="mt-6 text-[length:var(--text-hero)] font-extrabold leading-[0.92] tracking-[-0.04em] text-balance">
              Your bot trades.
              <br />
              Your prices stay{" "}
              <span style={{ color: "var(--color-magenta)" }}>unread</span>.
            </h1>

            <p className="mt-5 max-w-[52ch] text-[var(--color-text-2)]">
              Set a price to buy, a price to sell, a price to stop. They are
              encrypted in your browser and evaluated by a network where no
              single node holds them whole.
            </p>

            {/* The live on-chain figure the program decides from — not a chart
                feed that happens to agree with it. */}
            <div className="glow slab mt-7 p-5" data-fresh={fresh ? "1" : "0"}>
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="mono flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-3)]">
                    <span
                      className="live-dot inline-block h-2 w-2 rounded-full"
                      data-fresh={fresh ? "1" : "0"}
                      style={{ background: fresh ? "var(--color-up)" : "var(--color-amber)" }}
                      aria-hidden
                    />
                    SOL / USD · {age === null ? "—" : `${age}S`} OLD
                  </div>
                  <div className="mt-2 text-[length:var(--text-figure)] font-bold leading-none">
                    <Odometer value={oracle?.price ?? null} />
                  </div>
                </div>
                {change !== null ? (
                  <span className={`chip ${change >= 0 ? "chip-lime" : "chip-amber"}`}>
                    {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
                  </span>
                ) : null}
              </div>

              <div className="mt-3">
                <Spark rows={spark} height={54} />
              </div>

              <p className="mono mt-2 text-[11px] leading-relaxed text-[var(--color-text-3)]">
                on-chain Pyth account {ORACLE.slice(0, 8)}…{ORACLE.slice(-5)}
                {oracle ? ` · via ${oracle.via === "socket" ? "websocket push" : "http poll"}` : ""}
              </p>
              <span className="ast">
                {fresh
                  ? "INSIDE THE 30-SECOND STALENESS LIMIT THE PROGRAM ENFORCES"
                  : "OLDER THAN THE 30-SECOND LIMIT THE PROGRAM ENFORCES — IT WOULD REFUSE TO TRADE ON THIS. DEVNET PUBLISHES LESS OFTEN THAN MAINNET."}
              </span>
            </div>

            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/app/market" className="btn btn-primary">
                Open the app →
              </Link>
              <a href="#play" className="btn btn-ghost">
                Watch it run ↓
              </a>
            </div>
          </div>

          <div className="stage" ref={stage}>
            <div className="rig">
              <Machine price={oracle?.price ?? null} />
            </div>
          </div>
        </div>
      </section>

      <Marquee />

      {/* ------------------------------------------------------------ play */}
      <section id="play" className="defer mx-auto max-w-[1240px] scroll-mt-16 px-4 py-24 sm:px-7">
        <div className="reveal">
          <h2 className="text-[length:var(--text-sec)] font-extrabold tracking-[-0.03em]">
            Drag the numbers. Watch it fire.
          </h2>
          <p className="mt-3 max-w-[62ch] text-[var(--color-text-2)]">
            Real SOL candles, last 24 hours, relayed from Pyth by this site’s own
            server.
          </p>
        </div>
        <div className="reveal mt-8">
          <Playground spot={oracle?.price ?? null} />
        </div>
      </section>

      {/* --------------------------------------------- public vs hidden */}
      <section className="defer mx-auto max-w-[1240px] px-4 py-24 sm:px-7">
        <h2 className="reveal text-[length:var(--text-sec)] font-extrabold tracking-[-0.03em]">
          The trade is public. The rule is not.
        </h2>

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <div className="reveal slab p-7">
            <div className="mono flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-cyan)]">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--color-cyan)]"
                aria-hidden
              />
              Public · on Solana
            </div>
            <ul className="mt-5 space-y-2.5">
              {[
                "that a trade happened",
                "how big it was",
                "the price at the time",
                "both vault balances",
                "your size cap",
                "that a ciphertext exists",
              ].map((t) => (
                <li key={t} className="pub text-[15px]">
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="reveal slab p-7">
            <div className="mono flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-magenta)]">
              <LockGlyph />
              Never leaves the computation
            </div>
            <ul className="mt-5 space-y-3">
              {["buy under", "sell over", "stop below"].map((t) => (
                <li key={t}>
                  <span className="hid">
                    <LockGlyph />
                    {t}
                  </span>
                </li>
              ))}
            </ul>
            <span className="ast">
              SIZE IS PUBLIC ON PURPOSE — ONE TRADE RECOVERS IT EXACTLY → T-38
            </span>
          </div>
        </div>

        <p className="reveal mono mt-7 text-[13px] uppercase tracking-[0.1em] text-[var(--color-amber)]">
          Every fill is a labelled inequality. Enough of them narrow the three
          prices. Unread, not unknowable.
        </p>

        <div className="reveal slab slab-hi mt-8 p-7">
          <p className="text-[length:var(--text-card)] font-bold leading-tight">
            No instruction in the deployed program accepts an operator authority.
          </p>
          <span className="ast">
            A TEST FAILS IF THAT CHECK IS REMOVED (T-1, T-5) · TRUE OF THE
            DEPLOYED CODE — SEE CARD 1 BELOW
          </span>
        </div>
      </section>

      {/* --------------------------------------------------- the grade rack
          The register goes cold for exactly one screen. No glow, no candy
          fill, flat mono badges, void ground. Playfulness is being spent to
          buy the caveats their impact, not to crowd them out. */}
      <section
        className="defer border-y-[3px] border-[var(--color-stroke)] bg-[var(--color-void)] px-4 py-24 sm:px-7"
        style={{ perspective: "1400px" }}
      >
        <div className="mx-auto max-w-[1240px]">
          <h2 className="reveal text-[length:var(--text-sec)] font-extrabold tracking-[-0.03em]">
            Four things this does not do.
          </h2>
          <p className="reveal mono mt-3 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-3)]">
            Grades and threat IDs from SECURITY.md
          </p>

          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {GRADES.map((g) => (
              <article
                key={g.badge}
                tabIndex={0}
                className="reveal group slab-flat p-7 transition-transform duration-200 hover:[transform:rotateY(-14deg)_translateZ(28px)_translateX(10px)] focus:[transform:rotateY(-14deg)_translateZ(28px)_translateX(10px)]"
              >
                <span
                  className="mono inline-block rounded-md border-2 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.14em]"
                  style={{ color: g.tone, borderColor: g.tone }}
                >
                  {g.badge}
                </span>
                <h3 className="mt-4 text-[length:var(--text-card)] font-bold leading-tight">
                  {g.head}
                </h3>
                <p className="mt-3 text-[15px] text-[var(--color-text-2)]">{g.body}</p>
                <p className="mono mt-4 max-h-0 overflow-hidden text-[11px] leading-relaxed text-[var(--color-text-3)] transition-all duration-300 group-hover:max-h-48 group-focus:max-h-48">
                  {g.reveal}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ checkable */}
      <section className="defer mx-auto max-w-[1240px] px-4 py-24 sm:px-7">
        <h2 className="reveal text-[length:var(--text-sec)] font-extrabold tracking-[-0.03em]">
          All of it is checkable.
        </h2>
        <div className="reveal slab mono mt-8 space-y-2 overflow-x-auto p-7 text-[13px]">
          {[
            ["program", `${PROGRAM} · devnet`],
            ["oracle", ORACLE],
            ["cluster", "arcium offset 456 (devnet)"],
            [
              "circuit",
              "evaluate_strategy_v3 — 3 encrypted u64 in, 4 public inputs, 2 revealed outputs",
            ],
            ["pair", "SOL / USDC — one tradable pair, compiled into the program"],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-4 whitespace-nowrap">
              <span className="w-[72px] shrink-0 text-[var(--color-text-3)]">{k}</span>
              <span className="select-all text-[var(--color-text-2)]">{v}</span>
            </div>
          ))}
        </div>

        <div className="reveal mt-10 flex flex-wrap gap-3">
          <Link href="/app/market" className="btn btn-primary">
            Open the app →
          </Link>
          <a href={REPO} target="_blank" rel="noreferrer noopener" className="btn btn-ghost">
            Read the code
          </a>
        </div>
      </section>

      <footer className="border-t-[3px] border-[var(--color-stroke)] px-4 py-8 sm:px-7">
        <p className="mx-auto max-w-[1240px] text-[13px] text-[var(--color-text-3)]">
          Devnet. Unaudited. Nothing here is financial advice, a return, or a
          promise.{" "}
          <a
            className="underline underline-offset-2 hover:text-[var(--color-text-2)]"
            href={`${REPO}/blob/main/SECURITY.md`}
            target="_blank"
            rel="noreferrer noopener"
          >
            SECURITY.md
          </a>{" "}
          ·{" "}
          <a
            className="underline underline-offset-2 hover:text-[var(--color-text-2)]"
            href={REPO}
            target="_blank"
            rel="noreferrer noopener"
          >
            source
          </a>
        </p>
      </footer>
    </div>
  );
}

function Keyhole() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <rect width="22" height="22" rx="6" fill="var(--color-lime)" />
      <circle cx="11" cy="9" r="3.2" fill="var(--color-on-lime)" />
      <path d="M9.4 11.5h3.2l1 5.2H8.4z" fill="var(--color-on-lime)" />
    </svg>
  );
}
