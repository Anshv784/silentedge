"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { IChartApi, ISeriesApi, Time, UTCTimestamp } from "lightweight-charts";
import { SPRINGS } from "@/components/ui";

/**
 * Drawing tools.
 *
 * `lightweight-charts` draws data, not annotations, so this is an SVG layer on
 * top of its canvas. Every shape is stored in *chart* coordinates — a time and
 * a price — and reprojected to pixels each frame, which is what makes a
 * trendline stay attached to the two candles it was drawn between while you
 * pan and zoom, rather than sliding around as a fixed pixel offset would.
 *
 * Nothing here is persisted. A line drawn at the level you intend to buy is a
 * statement about your strategy, and this repository already refuses to write
 * the strategy draft to disk for exactly that reason — writing the same number
 * to `localStorage` because it arrived as a drawing instead of as a form field
 * would be the same leak through a different door. Drawings live for as long as
 * the tab does, and the app says so in the toolbar.
 */

export type Tool =
  | "cursor"
  | "trend"
  | "ray"
  | "horizontal"
  | "rect"
  | "fib"
  | "measure";

export type Point = { time: number; price: number };

export type Drawing = {
  id: string;
  tool: Exclude<Tool, "cursor">;
  points: Point[];
  color: string;
};

/** Screen-space projection of a drawing, or null if it is off-chart. */
type XY = { x: number; y: number };

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/* Annotation colours.
   These are the drawing palette, not the semantic tokens — an annotation is
   the user's own mark and carries no claim about visibility. They deliberately
   avoid magenta, which means "never leaves the computation" everywhere else on
   the site and must not become something a user can scribble with. */
export const PALETTE = [
  "var(--color-lime)",
  "var(--color-cyan)",
  "var(--color-up)",
  "var(--color-down)",
  "var(--color-amber)",
];

const TOOLS: { id: Tool; label: string; hint: string; path: string }[] = [
  {
    id: "cursor",
    label: "Cursor",
    hint: "Pan and zoom. Click a shape to select it.",
    path: "M3 2l9 7-4 .6 2.2 4-1.9.9-2.1-4L3 13z",
  },
  {
    id: "trend",
    label: "Trend line",
    hint: "Drag between two points.",
    path: "M2.5 12.5L13 3",
  },
  {
    id: "ray",
    label: "Ray",
    hint: "Drag two points; extends to the right edge.",
    path: "M2.5 11.5L9 6.5M9 6.5l4.5-1M9 6.5l-.6 4",
  },
  {
    id: "horizontal",
    label: "Price level",
    hint: "Click to place a level across the chart.",
    path: "M2 8h12",
  },
  {
    id: "rect",
    label: "Zone",
    hint: "Drag a box over a range you care about.",
    path: "M3 4.5h10v7H3z",
  },
  {
    id: "fib",
    label: "Fibonacci",
    hint: "Drag from a swing low to a swing high.",
    path: "M2 4h12M2 7h12M2 10h12M2 13h8",
  },
  {
    id: "measure",
    label: "Measure",
    hint: "Drag to read the move in price, percent and bars.",
    path: "M2.5 9.5l7-7 4 4-7 7zM6 5l1.5 1.5M8 3l1.5 1.5M4 7l1.5 1.5",
  },
];

let seq = 0;
const nextId = () => `d${++seq}`;

export function DrawingLayer({
  chart,
  series,
  tool,
  color,
  drawings,
  onCommit,
  selected,
  onSelect,
  /** Bumped by the parent whenever candles change, to force a reprojection. */
  revision,
}: {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  tool: Tool;
  color: string;
  drawings: Drawing[];
  onCommit: (d: Drawing) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  revision: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /**
   * Height of the price pane alone.
   *
   * The overlay spans the whole chart element, which includes the RSI and MACD
   * panes underneath. `priceToCoordinate` measures from the top of the *price*
   * pane and happily returns a coordinate past its bottom edge, so without a
   * clip a Fibonacci level or a trendline is drawn straight across the
   * oscillators as though it belonged to them.
   */
  const [paneH, setPaneH] = useState(0);
  const clipId = useRef(`clip-${Math.random().toString(36).slice(2, 9)}`);
  const [draft, setDraft] = useState<Drawing | null>(null);
  /** Incremented whenever the projection changed, to trigger a re-render. */
  const [, setTick] = useState(0);
  const dragging = useRef(false);

  /* ------------------------------------------------------- projection ---- */

  const toXY = useCallback(
    (p: Point): XY | null => {
      if (!chart || !series) return null;
      const x = chart.timeScale().timeToCoordinate(p.time as UTCTimestamp);
      const y = series.priceToCoordinate(p.price);
      if (x === null || y === null) return null;
      return { x, y };
    },
    [chart, series]
  );

  const toPoint = useCallback(
    (x: number, y: number): Point | null => {
      if (!chart || !series) return null;
      const price = series.coordinateToPrice(y);
      if (price === null) return null;
      // Past the last candle `coordinateToTime` returns null, so a drawing
      // extended into empty space to the right falls back to the logical
      // index converted through the visible range. Without this the second
      // point of a trendline vanishes the moment it leaves the data.
      const t = chart.timeScale().coordinateToTime(x);
      if (t !== null) return { time: t as number, price: price as number };
      const logical = chart.timeScale().coordinateToLogical(x);
      const range = chart.timeScale().getVisibleRange();
      if (logical === null || !range) return null;
      const span = (range.to as number) - (range.from as number);
      const vis = chart.timeScale().getVisibleLogicalRange();
      if (!vis || vis.to === vis.from) return null;
      const perBar = span / (vis.to - vis.from);
      return {
        time: (range.to as number) + (logical - vis.to) * perBar,
        price: price as number,
      };
    },
    [chart, series]
  );

  /* Reproject every frame, but only re-render when the projection actually
     moved. Panning, zooming, an autoscale from new data and a price-scale drag
     all change it, and only some of them emit an event to subscribe to. */
  useEffect(() => {
    if (!chart || !series) return;
    let raf = 0;
    let last = "";
    const loop = () => {
      const r = chart.timeScale().getVisibleLogicalRange();
      const el = host.current;
      // Two reference prices, so a pure vertical rescale is detected too.
      const a = series.priceToCoordinate(1);
      const b = series.priceToCoordinate(1000);
      const ph = chart.panes()[0]?.getHeight() ?? 0;
      const sig = `${r?.from ?? ""}|${r?.to ?? ""}|${a}|${b}|${el?.clientWidth}|${el?.clientHeight}|${ph}|${revision}`;
      if (sig !== last) {
        last = sig;
        if (el) setSize({ w: el.clientWidth, h: el.clientHeight });
        setPaneH(ph);
        setTick((t) => t + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [chart, series, revision]);

  /* ---------------------------------------------------------- pointer ---- */

  const local = (e: React.PointerEvent) => {
    const r = host.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent) => {
    if (tool === "cursor") return;
    const { x, y } = local(e);
    const p = toPoint(x, y);
    if (!p) return;
    e.preventDefault();
    host.current?.setPointerCapture(e.pointerId);
    dragging.current = true;
    setDraft({
      id: nextId(),
      tool: tool as Exclude<Tool, "cursor">,
      points: tool === "horizontal" ? [p] : [p, p],
      color,
    });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current || !draft || draft.tool === "horizontal") return;
    const { x, y } = local(e);
    const p = toPoint(x, y);
    if (!p) return;
    setDraft({ ...draft, points: [draft.points[0], p] });
  };

  const onUp = (e: React.PointerEvent) => {
    if (!dragging.current || !draft) return;
    dragging.current = false;
    host.current?.releasePointerCapture(e.pointerId);
    const [a, b] = draft.points;
    // A click that never moved is not a shape — except for a price level,
    // which is exactly one click by design.
    if (draft.tool !== "horizontal" && b) {
      const pa = toXY(a);
      const pb = toXY(b);
      if (!pa || !pb || Math.hypot(pb.x - pa.x, pb.y - pa.y) < 6) {
        setDraft(null);
        return;
      }
    }
    onCommit(draft);
    setDraft(null);
  };

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      dragging.current = false;
      setDraft(null);
      onSelect(null);
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onSelect]);

  /* ------------------------------------------------------------ render --- */

  const shapes = draft ? [...drawings, draft] : drawings;
  const { w, h } = size;

  return (
    <div
      ref={host}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className="absolute inset-x-0 top-0"
      style={{
        /* Above the chart's own canvas.
           lightweight-charts renders its canvases at `z-index: 2`, and this
           layer had no z-index at all — so the canvas sat on top and swallowed
           every pointer event before it could reach a handler here. Nothing was
           ever drawn, which also made the colour swatches and the rectangle and
           fibonacci tools look broken: they were fine, they just never received
           a drag. */
        zIndex: 3,
        // Bounded to the price pane: dragging across the RSI strip should not
        // begin a drawing that cannot be placed there.
        height: paneH || "100%",
        // In cursor mode the layer is transparent to the mouse so the chart
        // still pans; individual shapes opt back in for hit testing.
        pointerEvents: tool === "cursor" ? "none" : "auto",
        cursor: tool === "cursor" ? undefined : "crosshair",
        touchAction: tool === "cursor" ? undefined : "none",
      }}
    >
      <svg width={w} height={h} className="absolute inset-0">
        <defs>
          <clipPath id={clipId.current}>
            <rect x={0} y={0} width={w} height={paneH || h} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId.current})`}>
          {shapes.map((d) => (
            <Shape
              key={d.id}
              d={d}
              toXY={toXY}
              w={w}
              h={paneH || h}
              selected={d.id === selected}
              interactive={tool === "cursor" && d !== draft}
              onSelect={onSelect}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

/* -------------------------------------------------------------- one shape */

function Shape({
  d,
  toXY,
  w,
  h,
  selected,
  interactive,
  onSelect,
}: {
  d: Drawing;
  toXY: (p: Point) => XY | null;
  w: number;
  h: number;
  selected: boolean;
  interactive: boolean;
  onSelect: (id: string | null) => void;
}) {
  const a = toXY(d.points[0]);
  const b = d.points[1] ? toXY(d.points[1]) : null;
  if (!a) return null;

  const stroke = d.color;
  const width = selected ? 2 : 1.4;
  const hit = interactive
    ? {
        // A fat invisible stroke under the visible one, so a 1px line is
        // still clickable without demanding pixel precision.
        pointerEvents: "stroke" as const,
        cursor: "pointer",
        onPointerDown: (e: React.PointerEvent) => {
          e.stopPropagation();
          onSelect(d.id);
        },
      }
    : {};

  const label = (
    x: number,
    y: number,
    text: string,
    anchor: "start" | "middle" | "end" = "start"
  ) => (
    <text
      x={x}
      y={y}
      fill={stroke}
      fontSize={10}
      fontFamily="var(--font-mono)"
      textAnchor={anchor}
      style={{ pointerEvents: "none" }}
    >
      {text}
    </text>
  );

  if (d.tool === "horizontal") {
    return (
      <g>
        <line
          x1={0}
          x2={w}
          y1={a.y}
          y2={a.y}
          stroke="transparent"
          strokeWidth={10}
          {...hit}
        />
        <line
          x1={0}
          x2={w}
          y1={a.y}
          y2={a.y}
          stroke={stroke}
          strokeWidth={width}
          strokeDasharray={selected ? undefined : "6 4"}
          style={{ pointerEvents: "none" }}
        />
        {label(6, a.y - 5, fmt(d.points[0].price))}
      </g>
    );
  }

  if (!b) return null;

  if (d.tool === "rect") {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const rw = Math.abs(b.x - a.x);
    const rh = Math.abs(b.y - a.y);
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={rw}
          height={rh}
          fill={`color-mix(in srgb, ${stroke} 12%, transparent)`}
          stroke={stroke}
          strokeWidth={width}
          {...(interactive
            ? { pointerEvents: "all" as const, cursor: "pointer", onPointerDown: hit.onPointerDown }
            : { style: { pointerEvents: "none" } })}
        />
        {label(x + 4, y - 5, `${fmt(Math.max(d.points[0].price, d.points[1].price))} – ${fmt(Math.min(d.points[0].price, d.points[1].price))}`)}
      </g>
    );
  }

  if (d.tool === "fib") {
    const hi = Math.max(d.points[0].price, d.points[1].price);
    const lo = Math.min(d.points[0].price, d.points[1].price);
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    return (
      <g>
        {FIB.map((f) => {
          const price = hi - (hi - lo) * f;
          const p = toXY({ time: d.points[0].time, price });
          if (!p) return null;
          return (
            <g key={f}>
              <line
                x1={x1}
                x2={w}
                y1={p.y}
                y2={p.y}
                stroke={stroke}
                strokeWidth={f === 0 || f === 1 ? width : 1}
                strokeOpacity={f === 0 || f === 1 ? 1 : 0.55}
                strokeDasharray={f === 0 || f === 1 ? undefined : "4 4"}
                style={{ pointerEvents: "none" }}
              />
              {label(x1 + 4, p.y - 4, `${(f * 100).toFixed(1)}%  ${fmt(price)}`)}
            </g>
          );
        })}
        <line
          x1={x1}
          x2={x2}
          y1={a.y}
          y2={b.y}
          stroke="transparent"
          strokeWidth={12}
          {...hit}
        />
      </g>
    );
  }

  // trend, ray and measure are all a segment; the last two add something.
  let end = b;
  if (d.tool === "ray") {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx !== 0 || dy !== 0) {
      // Extend to the right edge, keeping the slope.
      const k = dx === 0 ? 0 : (w - a.x) / dx;
      end = k > 1 ? { x: w, y: a.y + dy * k } : b;
    }
  }

  const move = d.points[1].price - d.points[0].price;
  const movePct =
    d.points[0].price !== 0 ? (move / d.points[0].price) * 100 : 0;
  const up = move >= 0;

  return (
    <g>
      <line
        x1={a.x}
        x2={end.x}
        y1={a.y}
        y2={end.y}
        stroke="transparent"
        strokeWidth={12}
        {...hit}
      />
      <line
        x1={a.x}
        x2={end.x}
        y1={a.y}
        y2={end.y}
        stroke={d.tool === "measure" ? (up ? "var(--color-up)" : "var(--color-down)") : stroke}
        strokeWidth={width}
        strokeDasharray={d.tool === "measure" ? "5 4" : undefined}
        style={{ pointerEvents: "none" }}
      />
      {selected
        ? [a, end].map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={3.5}
              fill="var(--color-void)"
              stroke={stroke}
              strokeWidth={1.5}
              style={{ pointerEvents: "none" }}
            />
          ))
        : null}
      {d.tool === "measure" ? (
        <g style={{ pointerEvents: "none" }}>
          <rect
            x={Math.min(a.x, b.x) + Math.abs(b.x - a.x) / 2 - 54}
            y={Math.min(a.y, b.y) + Math.abs(b.y - a.y) / 2 - 11}
            width={108}
            height={22}
            rx={4}
            fill="var(--color-card)"
            stroke={up ? "var(--color-up)" : "var(--color-down)"}
          />
          <text
            x={Math.min(a.x, b.x) + Math.abs(b.x - a.x) / 2}
            y={Math.min(a.y, b.y) + Math.abs(b.y - a.y) / 2 + 4}
            fill={up ? "var(--color-up)" : "var(--color-down)"}
            fontSize={10}
            fontFamily="var(--font-mono)"
            textAnchor="middle"
          >
            {`${up ? "+" : ""}${fmt(move)}  ${up ? "+" : ""}${movePct.toFixed(2)}%`}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/** Magnitude-aware, so a BONK trendline is not labelled 0.00. */
function fmt(n: number): string {
  const a = Math.abs(n);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : a >= 0.0001 ? 6 : 8;
  return n.toFixed(dp);
}

/* ------------------------------------------------------------------ toolbar */

export function DrawingToolbar({
  tool,
  setTool,
  color,
  setColor,
  count,
  selected,
  onDelete,
  onClear,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  color: string;
  setColor: (c: string) => void;
  count: number;
  selected: string | null;
  onDelete: () => void;
  onClear: () => void;
}) {
  const active = TOOLS.find((t) => t.id === tool)!;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selected) {
          e.preventDefault();
          onDelete();
        }
      }
      const idx = "1234567".indexOf(e.key);
      if (idx >= 0 && TOOLS[idx]) setTool(TOOLS[idx].id);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [selected, onDelete, setTool]);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-stroke)] px-4 py-3">
      <div className="flex items-center gap-0.5 rounded-full bg-[var(--color-card)] p-1">
        {TOOLS.map((t, i) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            title={`${t.label} (${i + 1}) — ${t.hint}`}
            aria-label={t.label}
            aria-pressed={tool === t.id}
            className={`relative flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              tool === t.id
                ? "text-[var(--color-on-signal)]"
                : "text-[var(--color-text-3)] hover:text-[var(--color-text)]"
            }`}
          >
            {tool === t.id ? (
              <motion.span
                layoutId="tool-active"
                className="absolute inset-0 rounded-full bg-[var(--color-lime)]"
                transition={SPRINGS.snap}
              />
            ) : null}
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              className="relative"
              aria-hidden
            >
              <path
                d={t.path}
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill={t.id === "cursor" ? "currentColor" : "none"}
              />
            </svg>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        {PALETTE.map((c) => (
          <motion.button
            key={c}
            onClick={() => setColor(c)}
            aria-label={`Colour ${c}`}
            whileTap={{ scale: 0.9 }}
            className="h-[18px] w-[18px] rounded-full ring-2 transition-transform hover:scale-110"
            style={{
              background: c,
              // The chosen swatch gets a ring in its own colour, so the
              // selection reads on every theme rather than only on dark ones.
              boxShadow:
                c === color
                  ? `0 0 0 2px var(--color-card), 0 0 0 3.5px ${c}`
                  : undefined,
              // @ts-expect-error CSS custom property passthrough
              "--tw-ring-color": "var(--color-stroke)",
            }}
          />
        ))}
      </div>

      <span className="hidden text-[13px] text-[var(--color-text-3)] lg:inline">
        {active.hint}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <AnimatePresence>
          {selected ? (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              onClick={onDelete}
              className="btn btn-danger h-8 px-3"
            >
              Delete
            </motion.button>
          ) : null}
        </AnimatePresence>
        {count > 0 ? (
          <button
            onClick={onClear}
            className="btn btn-ghost h-8 px-3"
            title="Drawings are kept in this tab only and are never written to disk"
          >
            Clear {count}
          </button>
        ) : null}
      </div>
    </div>
  );
}
