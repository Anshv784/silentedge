"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useSpring, useTransform, type Variants } from "motion/react";

/**
 * The primitives.
 *
 * Two rules run through everything here.
 *
 * **Nothing calls `useReducedMotion` any more.** `<MotionConfig
 * reducedMotion="user">` in `app/app/layout.tsx` covers the app tree,
 * including components not yet written. Four hand-rolled guards used to live
 * in this file and six animated components elsewhere had none at all.
 *
 * **Springs are named, and the choice is semantic.** A spring that overshoots
 * displays, for a frame or two, a number that was never true. That is fine for
 * a price feed nobody acts on directly and not fine for a vault balance, so
 * `money` is critically damped and is the default. See `SPRINGS`.
 */

/* ---------------------------------------------------------------- motion */

/**
 * Three springs, no fourth.
 *
 *  - `feed`  ζ ≈ 0.85. Pure-display figures only — the oracle price, the tape,
 *            the terminal readout. A 120ms overshoot on a display feed means
 *            nothing to anyone.
 *  - `money` ζ ≈ 1.04, no overshoot. Mandatory on any figure a user could act
 *            on: vault value, withdrawable, trade size, simulated return.
 *  - `snap`  ζ ≈ 0.87. Layout pills that slide between positions.
 */
export const SPRINGS = {
  feed: { stiffness: 220, damping: 24, mass: 0.6 },
  money: { stiffness: 220, damping: 30, mass: 0.6 },
  snap: { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.8 },
};

/**
 * Section entrance, driven by scroll rather than by hydration.
 *
 * Everything used to animate the moment React mounted, which meant every
 * section below the fold finished its entrance while off-screen and was
 * already static by the time anyone scrolled to it. Put `REVEAL` on a section
 * and `REVEAL_ITEM` on its children.
 */
export const REVEAL: Variants = {
  hide: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } },
};

export const REVEAL_ITEM: Variants = {
  hide: { opacity: 0, y: 24 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
  },
};

/** A section that plays its children in when it scrolls into view. Once. */
export function Reveal({
  children,
  className = "",
  as = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div";
}) {
  const C = as === "div" ? motion.div : motion.section;
  return (
    <C
      variants={REVEAL}
      initial="hide"
      whileInView="show"
      viewport={{ once: true, margin: "-12% 0px" }}
      className={className}
    >
      {children}
    </C>
  );
}

/* ----------------------------------------------------------------- block */

/**
 * One cell of the ruled field.
 *
 * There is no border, no radius and no shadow: cells sit in a `.ledger` grid
 * with a 1px gap, so the rule between two blocks is shared rather than drawn
 * twice. This replaced nineteen individually bordered cards whose hairline
 * measured 1.13:1 against the page — visible in a screenshot, invisible on a
 * monitor.
 */
export function Block({
  children,
  className = "",
  prov,
  reveal = true,
}: {
  children: ReactNode;
  className?: string;
  /** Declares whether the data inside is readable on chain, or is not. */
  prov?: "public" | "private";
  reveal?: boolean;
}) {
  const p = prov ? `prov prov-${prov}` : "";
  if (!reveal) {
    return <section className={`card ${p} ${className}`}>{children}</section>;
  }
  return (
    <motion.section variants={REVEAL_ITEM} className={`card ${p} ${className}`}>
      {children}
    </motion.section>
  );
}

export function BlockHead({
  title,
  hint,
  eyebrow,
  right,
}: {
  title: string;
  hint?: string;
  eyebrow?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="u-label mb-2">
            {eyebrow}
          </div>
        ) : null}
        <h2 className="text-lead font-medium">{title}</h2>
        {hint ? (
          <p className="mt-1.5 text-caption text-[var(--color-ink-soft)]">
            {hint}
          </p>
        ) : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="u-label text-[var(--color-ink-soft)]">{children}</div>;
}

/* -------------------------------------------------------------- page head */

/**
 * A page's identity, in the content column where it belongs.
 *
 * This used to be a 14px `<h1>` in the sticky header — the same size as body
 * copy, sitting above the tape, so an app screen opened with 84px of chrome in
 * the 11–14px band and no declared subject at all. At `--text-title` it is
 * 1.75× body and is unambiguously the first thing on the page.
 */
export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-title">{title}</h1>
        {subtitle ? (
          <p className="mt-2 text-caption text-[var(--color-ink-soft)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ provenance */

/**
 * The visibility chip.
 *
 * `exposed` and `shielded` were text tints referenced nine and fourteen times.
 * They are the product's whole axis, so they are structure now: a 3px rule
 * down the left of the block via `.prov`, and this label saying which.
 */
export function Prov({
  tone,
  children,
}: {
  tone: "public" | "private";
  children?: ReactNode;
}) {
  const color =
    tone === "public" ? "var(--color-exposed)" : "var(--color-shielded)";
  return (
    <span className="u-label inline-flex items-center gap-1.5" style={{ color }}>
      <span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0"
        style={{ background: color }}
      />
      {children ?? (tone === "public" ? "Exposed · on chain" : "Shielded · in MPC")}
    </span>
  );
}

/* ----------------------------------------------------------------- badge */

const TONE: Record<string, string> = {
  neutral:
    "border-[var(--color-rule-strong)] text-[var(--color-ink-soft)] bg-transparent",
  accent:
    "border-[color-mix(in_srgb,var(--color-signal)_50%,transparent)] text-[var(--color-signal-hi)] bg-[color-mix(in_srgb,var(--color-signal)_16%,transparent)]",
  good: "border-[color-mix(in_srgb,var(--color-pos)_45%,transparent)] text-[var(--color-pos)] bg-[color-mix(in_srgb,var(--color-pos)_14%,transparent)]",
  warn: "border-[color-mix(in_srgb,var(--color-exposed)_45%,transparent)] text-[var(--color-exposed)] bg-[color-mix(in_srgb,var(--color-exposed)_14%,transparent)]",
  bad: "border-[color-mix(in_srgb,var(--color-neg)_45%,transparent)] text-[var(--color-neg)] bg-[color-mix(in_srgb,var(--color-neg)_14%,transparent)]",
  shielded:
    "border-[color-mix(in_srgb,var(--color-shielded)_45%,transparent)] text-[var(--color-shielded)] bg-[color-mix(in_srgb,var(--color-shielded)_14%,transparent)]",
};

export function Badge({
  children,
  tone = "neutral",
  dot,
}: {
  children: ReactNode;
  tone?: keyof typeof TONE | string;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[12px] font-medium ${
        TONE[tone] ?? TONE.neutral
      }`}
    >
      {/* A static square, not a pulsing circle. The pulse used to run on every
          status badge in the app, including ones stating a fixed fact like
          "devnet · unaudited" — an animation that says "live" attached to
          something that is not. */}
      {dot ? (
        <span className="h-1.5 w-1.5 shrink-0 bg-current" aria-hidden />
      ) : null}
      {children}
    </span>
  );
}

/* --------------------------------------------------------------- numbers */

/**
 * A figure that moves to its new value instead of jumping.
 *
 * Three jobs. The spring makes a changing price legible as *movement* — you
 * see it tick without watching it. The colour names the direction for the beat
 * after it changes. The cell wash extends that beat to the whole surrounding
 * block, which is what makes a dense ruled grid feel alive without any
 * always-on animation.
 *
 * The value is exact at rest: the spring settles on the real number and
 * `format` renders it, so nothing here invents precision the price lacks.
 */
export function Ticking({
  value,
  format,
  flash = true,
  cell = false,
  kind = "money",
  className = "",
}: {
  value: number | null;
  format: (n: number) => string;
  flash?: boolean;
  /** Wash the whole block, not just the glyphs. */
  cell?: boolean;
  /**
   * `money` is critically damped and is the default. A spring that overshoots
   * shows a number that was never true, which is not acceptable on a figure
   * someone might act on.
   */
  kind?: "feed" | "money";
  className?: string;
}) {
  const spring = useSpring(value ?? 0, SPRINGS[kind]);
  const text = useTransform(spring, (n) => format(n));
  const prev = useRef<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (value === null) return;
    if (prev.current !== null && prev.current !== value && flash) {
      setDir(value > prev.current ? "up" : "down");
      const id = setTimeout(() => setDir(null), 520);
      prev.current = value;
      spring.set(value);
      return () => clearTimeout(id);
    }
    prev.current = value;
    // The first real value lands immediately rather than counting up from
    // zero, which would read as the price having moved when the page merely
    // loaded.
    if (spring.get() === 0) spring.jump(value);
    else spring.set(value);
  }, [value, flash, spring]);

  if (value === null) return <span className={className}>—</span>;

  const tone =
    dir === "up"
      ? "var(--color-pos)"
      : dir === "down"
        ? "var(--color-neg)"
        : undefined;

  return (
    <motion.span
      className={className}
      animate={{
        color: tone ?? "currentColor",
        backgroundColor:
          cell && tone
            ? `color-mix(in srgb, ${tone} 16%, transparent)`
            : "rgba(0,0,0,0)",
      }}
      transition={{ duration: tone ? 0.1 : 0.45 }}
    >
      <motion.span>{text}</motion.span>
    </motion.span>
  );
}

/* ------------------------------------------------------------------ stat */

export function Stat({
  label,
  value,
  sub,
  tone,
  loading,
  figure = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "pos" | "neg";
  loading?: boolean;
  /** The one number per screen. Everything else stays at title size. */
  figure?: boolean;
}) {
  const color =
    tone === "pos"
      ? "text-[var(--color-pos)]"
      : tone === "neg"
        ? "text-[var(--color-neg)]"
        : "";
  return (
    <div>
      <div className="u-label">{label}</div>
      <div
        className={`tabular mt-3 ${figure ? "text-figure" : "text-title"} ${color}`}
      >
        {loading ? <Skeleton w="6ch" /> : value}
      </div>
      {sub ? (
        <div className="mt-2 text-caption text-[var(--color-ink-soft)]">{sub}</div>
      ) : null}
    </div>
  );
}

export function Row({
  label,
  value,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-rule)] py-3 last:border-0">
      <span className="text-caption text-[var(--color-ink-soft)]">
        {label}
        {hint ? (
          <span className="ml-2 text-[var(--color-ink-faint)]">{hint}</span>
        ) : null}
      </span>
      <span className="tabular text-[15px]">{value}</span>
    </div>
  );
}

/** A signal-tinted sweep. The old grey pulse was indistinguishable from a
    disabled control at rest. */
export function Skeleton({ w = "100%" }: { w?: string }) {
  return (
    <span
      aria-hidden
      className="relative inline-block h-[1em] overflow-hidden rounded-sm align-middle"
      style={{
        width: w,
        /* Neutral, not --color-signal. Signal is lime, the action colour, and
           at 10% over black it rendered every loading placeholder as a muddy
           olive bar that read as broken content rather than as pending. */
        background: "color-mix(in srgb, var(--color-stroke) 22%, transparent)",
      }}
    >
      <motion.span
        className="absolute inset-y-0 w-1/2"
        style={{
          background:
            "linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-text-3) 34%, transparent), transparent)",
        }}
        animate={{ x: ["-100%", "300%"] }}
        transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
      />
    </span>
  );
}

/* ----------------------------------------------------------------- seal */

/**
 * The moment a value stops being readable.
 *
 * A readable line and a redacted copy of the same width, stacked, with the
 * redaction wiped across it left to right by a lit edge. It fires when a real
 * encryption resolves — never on a timer and never on the marketing page,
 * because a dramatisation of encryption captioned "illustrative" is a
 * spectacle standing in for proof.
 *
 * The plaintext stays in the accessibility tree only until the wipe completes;
 * after that the element reads as what it is.
 */
export function Seal({
  value,
  done,
  label = "encrypted to the cluster",
}: {
  value: string;
  /** Flip to true when the real submission resolves. */
  done: boolean;
  label?: string;
}) {
  return (
    <span className="relative inline-flex flex-col">
      <span className="tabular relative inline-block overflow-hidden text-[15px]">
        <span aria-hidden={done}>{value}</span>
        <motion.span
          aria-hidden
          className="redacted absolute inset-0"
          initial={{ clipPath: "inset(0 100% 0 0)" }}
          animate={{ clipPath: done ? "inset(0 0% 0 0)" : "inset(0 100% 0 0)" }}
          transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
        />
        <motion.span
          aria-hidden
          className="absolute inset-y-0 w-px"
          style={{ background: "var(--color-shielded)" }}
          initial={{ left: "0%", opacity: 0 }}
          animate={
            done
              ? { left: "100%", opacity: [0, 1, 1, 0] }
              : { left: "0%", opacity: 0 }
          }
          transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
        />
      </span>
      {done ? (
        <span className="u-label mt-2 text-[var(--color-shielded)]">{label}</span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ gate */

/**
 * A state with nothing in it yet.
 *
 * Replaces the old dashed-border `Empty`, which was deleted rather than
 * restyled: a dashed grey rectangle is the universal signature of "nothing
 * here", and it was the first thing a visitor saw after the landing page's
 * primary call to action.
 *
 * This states the reason at reading size and puts the action at 44px. It is a
 * real surface, not an outline of one.
 */
export function Gate({
  title,
  children,
  action,
  prov,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  prov?: "public" | "private";
}) {
  return (
    <div className={`card ${prov ? `prov prov-${prov}` : ""} py-14`}>
      <div className="mx-auto max-w-lg text-center">
        <h2 className="text-title">{title}</h2>
        {children ? (
          <p className="mx-auto mt-4 max-w-md text-lead text-[var(--color-ink-soft)]">
            {children}
          </p>
        ) : null}
        {action ? (
          <div className="mt-7 flex justify-center">{action}</div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- alert */

export function Alert({
  tone = "warn",
  title,
  children,
}: {
  tone?: "warn" | "bad" | "accent";
  title?: string;
  children: ReactNode;
}) {
  const map = {
    warn: "var(--color-exposed)",
    bad: "var(--color-neg)",
    accent: "var(--color-signal)",
  } as const;
  const c = map[tone];
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden"
    >
      <div
        className="border-l-4 px-5 py-4 text-caption"
        style={{
          borderColor: c,
          background: `color-mix(in srgb, ${c} 10%, transparent)`,
        }}
      >
        {title ? (
          <strong className="mr-1.5 font-medium" style={{ color: c }}>
            {title}
          </strong>
        ) : null}
        <span className="text-[var(--color-ink-soft)]">{children}</span>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ misc */

export function Mono({
  children,
  copy,
}: {
  children: string | null | undefined;
  copy?: boolean;
}) {
  const text = children ?? "—";
  return (
    <span className="tabular inline-flex items-center gap-1.5 text-caption">
      <span className="text-[var(--color-ink-soft)]">
        {text.length > 16 ? `${text.slice(0, 6)}…${text.slice(-6)}` : text}
      </span>
      {copy && children ? (
        <button
          type="button"
          title="Copy"
          onClick={() => navigator.clipboard?.writeText(children)}
          className="text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" />
            <path
              d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1"
              stroke="currentColor"
            />
          </svg>
        </button>
      ) : null}
    </span>
  );
}

export function Cta({
  href,
  children,
  variant = "primary",
  size = "lg",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "ghost";
  size?: "lg" | "xl";
}) {
  return (
    <Link href={href} className={`btn btn-${size} btn-${variant}`}>
      {children}
    </Link>
  );
}

/**
 * A line chart with optional horizontal threshold bands. No charting
 * dependency: this is a polyline and three rules, which is all the data
 * deserves — and it keeps 150 kB of interactive charting off any page that
 * only needs a shape.
 */
export function Chart({
  points,
  height = 180,
  bands = [],
  marker,
  draw = false,
}: {
  points: { t: number; price: number }[];
  height?: number;
  bands?: { value: number; color: string; label: string }[];
  marker?: number | null;
  /** Draw the line on when it scrolls into view. */
  draw?: boolean;
}) {
  const W = 1000;
  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-caption text-[var(--color-ink-faint)]"
        style={{ height }}
      >
        No price history
      </div>
    );
  }

  const prices = points.map((p) => p.price);
  const relevant = [...prices, ...bands.map((b) => b.value).filter((v) => v > 0)];
  const lo = Math.min(...relevant);
  const hi = Math.max(...relevant);
  const span = hi - lo || 1;
  const pad = span * 0.08;
  const min = lo - pad;
  const max = hi + pad;

  const y = (p: number) => height - ((p - min) / (max - min)) * height;
  const x = (i: number) => (i / (points.length - 1)) * W;

  const line = prices
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${W},${height} L0,${height} Z`;
  const up = prices[prices.length - 1] >= prices[0];
  const stroke = up ? "var(--color-pos)" : "var(--color-neg)";
  const id = `fill-${Math.round(min)}-${Math.round(max)}`;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Price history"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.20" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id})`} />
        {draw ? (
          <motion.path
            d={line}
            fill="none"
            stroke={stroke}
            strokeWidth="1.75"
            vectorEffect="non-scaling-stroke"
            initial={{ pathLength: 0 }}
            whileInView={{ pathLength: 1 }}
            viewport={{ once: true, margin: "-12% 0px" }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          />
        ) : (
          <path
            d={line}
            fill="none"
            stroke={stroke}
            strokeWidth="1.75"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {bands
          .filter((b) => b.value > min && b.value < max)
          .map((b) => (
            <line
              key={b.label}
              x1="0"
              x2={W}
              y1={y(b.value)}
              y2={y(b.value)}
              stroke={b.color}
              strokeWidth="1"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {marker && marker > min && marker < max ? (
          <line
            x1="0"
            x2={W}
            y1={y(marker)}
            y2={y(marker)}
            stroke="var(--color-ink-soft)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {bands
        .filter((b) => b.value > min && b.value < max)
        .map((b) => (
          <span
            key={b.label}
            className="u-label tabular pointer-events-none absolute right-0 -translate-y-1/2 px-1.5"
            style={{
              top: y(b.value),
              color: b.color,
              background: "var(--color-paper)",
            }}
          >
            {b.label}
          </span>
        ))}
    </div>
  );
}
