"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type CandlestickStyleOptions,
  type ChartOptions,
  type CrosshairLineOptions,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  bollinger,
  ema,
  macd as macdOf,
  rsi as rsiOf,
  type Series,
} from "@silentedge/sdk/indicators";
import { precisionFor, price as fmtPrice, type Candle } from "@/lib/market";
import { Prov } from "@/components/ui";
import {
  DrawingLayer,
  type Drawing,
  type Tool,
} from "@/components/drawings";

/**
 * The chart.
 *
 * Rendered with TradingView's `lightweight-charts` rather than hand-drawn SVG:
 * candles, a crosshair, pan and zoom, and synchronised sub-panes are a lot of
 * interaction code to get subtly wrong, and this is the library the exchanges
 * this is modelled on actually use.
 *
 * Two things it deliberately does not draw:
 *
 *   Volume. Pyth publishes prices, not trades — its history endpoint returns a
 *   volume array of zeros. A row of flat bars would look like a market with no
 *   activity, and a volume proxy derived from price movement would be a number
 *   nobody measured presented in the place traders look for one that was.
 *
 *   An order book. There is no book here to show. The vault swaps through
 *   Jupiter, against whatever pools it routes into.
 *
 * Every overlay is computed from the display series in `@silentedge/sdk`, and
 * none of it reaches the circuit — see `packages/sdk/src/indicators.ts`.
 */

export type Overlay = "ema" | "bollinger";
export type Study = "rsi" | "macd";

export type PriceMark = { price: number; color: string; title: string };

const CSS = (name: string, fallback: string) => {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
};

/**
 * A theme token at partial strength, as an 8-digit hex.
 *
 * The chart holds concrete colours on its canvas and parses them itself, so a
 * literal `color-mix(…, var(--token) …)` would be resolved once and then cached
 * under a key that does not change when the theme does. Every colour token in
 * `globals.css` is a six-digit hex; anything else is passed through at full
 * strength rather than being turned into a malformed colour.
 */
const MIX = (name: string, fallback: string, pct: number) => {
  const c = CSS(name, fallback);
  if (!/^#[0-9a-f]{6}$/i.test(c)) return c;
  return (
    c +
    Math.round((pct / 100) * 255)
      .toString(16)
      .padStart(2, "0")
  );
};

/**
 * Every colour the chart itself draws, re-read from the current theme.
 *
 * Construction and the theme-change effect below both call this, so the two
 * cannot drift apart — which is how the chart came to be styled twice.
 */
function chartPalette() {
  const rule = CSS("--color-rule", "#1e2023");
  const soft = CSS("--color-ink-soft", "#8a8f98");
  /* Solid, one pixel, in the accent. A dotted grey crosshair reads as a
     guide; this one reads as an instrument. */
  const cross: DeepPartial<CrosshairLineOptions> = {
    color: MIX("--color-signal", "#5b6bff", 55),
    width: 1,
    style: LineStyle.Solid,
    /*
     * `--color-ink`, not `--color-signal`.
     *
     * lightweight-charts picks the label's TEXT colour itself: it takes the
     * NTSC grayscale of this background and returns black above 160, white
     * below. There is no override. Every theme's signal falls below that
     * threshold, so the library paints white on it — which is fine on the
     * indigo and violet themes and about 2:1 on terminal's green and ember's
     * orange, i.e. unreadable in the two themes where a trader is most likely
     * to be squinting at a price.
     *
     * `ink` is at the far end of the ramp in every theme, so whichever
     * foreground the library derives is the high-contrast one. The accent
     * stays where it belongs: on the crosshair line itself.
     */
    labelBackgroundColor: CSS("--color-ink", "#f2f4f8"),
  };
  return {
    layout: {
      textColor: soft,
      panes: { separatorColor: rule, separatorHoverColor: rule },
    },
    /* Horizontal rules only. A candle is read against a price, and the time
       axis already labels itself — the vertical set is a second grid drawn
       for nothing, and dropping it halves the ink behind the data. */
    grid: {
      vertLines: { color: "transparent" },
      horzLines: { color: rule },
    },
    crosshair: { vertLine: cross, horzLine: cross },
    /* No scale borders: whatever frames the chart draws that edge, so the
       chart reads as embedded rather than as an iframe with a hairline. */
    rightPriceScale: { borderColor: "transparent" },
    timeScale: { borderColor: "transparent" },
  } satisfies DeepPartial<ChartOptions>;
}

/** The candle body and wick colours, likewise re-read on a theme change. */
function candlePalette(): DeepPartial<CandlestickStyleOptions> {
  return {
    upColor: CSS("--color-pos", "#4cb782"),
    downColor: CSS("--color-neg", "#e5484d"),
    /* No border. At these widths a one-pixel outline in the body's own colour
       only fattens the body; the wicks carry the range at 60% so the bodies
       are what the eye lands on. */
    borderVisible: false,
    wickUpColor: MIX("--color-pos", "#4cb782", 60),
    wickDownColor: MIX("--color-neg", "#e5484d", 60),
  };
}

/** Drop the leading nulls an indicator emits before it has warmed up. */
function toLine(candles: Candle[], series: Series): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = series[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    out.push({ time: candles[i].t as UTCTimestamp, value: v });
  }
  return out;
}

export type Hover = {
  time: number;
  o: number;
  h: number;
  l: number;
  c: number;
} | null;

export function Terminal({
  candles,
  overlays,
  studies,
  marks = [],
  height = 460,
  onHover,
  drawing,
  frame = false,
}: {
  candles: Candle[];
  overlays: Overlay[];
  studies: Study[];
  /** Horizontal lines — the strategy's levels, drawn where they sit. */
  marks?: PriceMark[];
  height?: number;
  onHover?: (h: Hover) => void;
  /**
   * Wrap the canvas in the raised chart frame with its provenance rule.
   *
   * The chart draws no border of its own, so where it is not already sitting
   * inside a framed cell it needs one — and the frame is where the data class
   * gets declared: these are public Pyth prices, readable by anyone.
   */
  frame?: boolean;
  /** Present only where the user is allowed to annotate the chart. */
  drawing?: {
    tool: Tool;
    color: string;
    drawings: Drawing[];
    onCommit: (d: Drawing) => void;
    selected: string | null;
    onSelect: (id: string | null) => void;
  };
}) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [ready, setReady] = useState(false);

  /* Read by the autoscale provider below, which the chart calls on every
     redraw. Keeping the marks in a ref rather than closing over the prop means
     the provider is installed once and still sees the current levels. */
  const markRef = useRef<PriceMark[]>(marks);
  markRef.current = marks;

  /**
   * Whether the chart has been torn down.
   *
   * React runs effect cleanups in declaration order, and the effect that
   * creates the chart is declared first — so on unmount `chart.remove()` runs
   * *before* the cleanups below that remove series and price lines from it.
   * Those calls then reach into a disposed canvas and throw "Object is
   * disposed", which surfaces as a dev-overlay error on every navigation away
   * from a chart page.
   *
   * A ref rather than state: it has to be readable synchronously inside a
   * cleanup that is already running.
   */
  const dead = useRef(false);

  /* The chart itself is created once. Data, overlays and studies are applied
     by the effects below, so switching a timeframe or toggling an indicator
     does not tear down and rebuild the canvas — which would lose the user's
     pan and zoom every time they touched a button. */
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const themed = chartPalette();
    const chart = createChart(el, {
      ...themed,
      layout: {
        ...themed.layout,
        background: { type: ColorType.Solid, color: "transparent" },
        fontFamily: CSS("--font-mono", "monospace"),
        fontSize: 12,
        attributionLogo: false,
      },
      crosshair: { ...themed.crosshair, mode: CrosshairMode.Normal },
      timeScale: { ...themed.timeScale, timeVisible: true, secondsVisible: false },
      autoSize: false,
      width: el.clientWidth,
      height,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      /* Widen the price scale to include the strategy's levels.
         Without this a take-profit set above the recent range is drawn off the
         top of the chart — the line exists but the user cannot see where their
         own level sits relative to price, which is the entire reason it is
         drawn. */
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const res = original();
        const levels = markRef.current
          .map((m) => m.price)
          .filter((p) => Number.isFinite(p) && p > 0);
        if (!res || levels.length === 0) return res;
        res.priceRange.minValue = Math.min(res.priceRange.minValue, ...levels);
        res.priceRange.maxValue = Math.max(res.priceRange.maxValue, ...levels);
        return res;
      },
      ...candlePalette(),
    });

    chartRef.current = chart;
    priceRef.current = candleSeries;
    dead.current = false;
    setReady(true);

    // ResizeObserver rather than a window listener: the sidebar collapsing or
    // a study pane appearing changes this element's width without the window
    // resizing at all.
    const ro = new ResizeObserver(([entry]) => {
      // `disconnect()` does not cancel an entry already queued for delivery.
      if (dead.current || entry.contentRect.width <= 0) return;
      chart.applyOptions({ width: Math.floor(entry.contentRect.width) });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      dead.current = true;
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      setReady(false);
    };
    // `height` is applied by its own effect so a change does not recreate the
    // chart and throw away the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (dead.current) return;
    chartRef.current?.applyOptions({ height });
  }, [height]);

  /**
   * Re-read the palette on a theme change.
   *
   * The chart resolves `var(--color-*)` once, at construction, into concrete
   * colours held on its canvas — so swapping the theme leaves a dark chart
   * sitting on a light page until this runs. Overlay and study series are
   * rebuilt by their own effects, which depend on `theme` for the same reason.
   */
  useEffect(() => {
    const chart = chartRef.current;
    const series = priceRef.current;
    if (!chart || !series || !ready || dead.current) return;
    chart.applyOptions(chartPalette());
    series.applyOptions(candlePalette());
  }, [ ready]);

  /* ------------------------------------------------------------ the price */
  useEffect(() => {
    const chart = chartRef.current;
    const series = priceRef.current;
    if (!chart || !series || !ready) return;

    series.setData(
      candles.map((c) => ({
        time: c.t as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      }))
    );

    // BONK needs eight decimals and BTC needs two; a fixed format renders one
    // of them as a flat line of zeros.
    const dp = precisionFor(candles.at(-1)?.c ?? 1);
    series.applyOptions({
      priceFormat: { type: "price", precision: dp, minMove: 1 / 10 ** dp },
    });
    chart.timeScale().fitContent();
  }, [candles, ready]);

  /* ------------------------------------------------------------- overlays */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || candles.length === 0) return;
    const closes = candles.map((c) => c.c);
    const added: ISeriesApi<"Line">[] = [];

    const line = (data: Series, color: string, title: string, width = 1) => {
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: width as 1 | 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title,
      });
      s.setData(toLine(candles, data));
      added.push(s);
    };

    if (overlays.includes("ema")) {
      line(ema(closes, 21), CSS("--color-signal-hi", "#7079e0"), "EMA 21");
      line(ema(closes, 99), CSS("--color-exposed", "#d9a441"), "EMA 99");
    }
    if (overlays.includes("bollinger")) {
      const bb = bollinger(closes, 20, 2);
      const dim = CSS("--color-ink-faint", "#5c6066");
      line(bb.upper, dim, "BB upper");
      line(bb.middle, dim, "BB 20");
      line(bb.lower, dim, "BB lower");
    }

    return () => {
      if (dead.current) return;
      for (const s of added) chart.removeSeries(s);
    };
  }, [candles, overlays, ready]);

  /* --------------------------------------------------------------- marks */
  useEffect(() => {
    const series = priceRef.current;
    if (!series || !ready) return;
    const lines = marks
      .filter((m) => Number.isFinite(m.price) && m.price > 0)
      .map((m) =>
        series.createPriceLine({
          price: m.price,
          color: m.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: m.title,
        })
      );
    // The autoscale provider reads `markRef` on redraw, so a level that moves
    // outside the current range needs a redraw to be brought back into view.
    if (!dead.current) {
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    }

    return () => {
      if (dead.current) return;
      for (const l of lines) series.removePriceLine(l);
    };
    // Marks are a small array rebuilt on every render by the caller, so it is
    // compared by content rather than identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(marks), ready]);

  /* -------------------------------------------------------------- studies */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || candles.length === 0) return;
    const closes = candles.map((c) => c.c);
    const added: ISeriesApi<"Line" | "Histogram">[] = [];
    let pane = 1;

    if (studies.includes("rsi")) {
      const idx = pane++;
      const s = chart.addSeries(
        LineSeries,
        {
          color: CSS("--color-signal-hi", "#7079e0"),
          lineWidth: 1,
          priceLineVisible: false,
          title: "RSI 14",
          priceFormat: { type: "price", precision: 1, minMove: 0.1 },
        },
        idx
      );
      s.setData(toLine(candles, rsiOf(closes, 14)));
      // The 70/30 bands are the conventional reference, drawn so the line has
      // something to be read against rather than floating in an empty pane.
      for (const level of [70, 30]) {
        s.createPriceLine({
          price: level,
          color: CSS("--color-rule-strong", "#2b2f33"),
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: "",
        });
      }
      added.push(s);
      chart.panes()[idx]?.setHeight(90);
    }

    if (studies.includes("macd")) {
      const idx = pane++;
      const m = macdOf(closes);
      const pos = CSS("--color-pos", "#4cb782");
      const neg = CSS("--color-neg", "#e5484d");

      const hist = chart.addSeries(
        HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false, title: "MACD" },
        idx
      );
      hist.setData(
        toLine(candles, m.histogram).map((d) => ({
          ...d,
          color: d.value >= 0 ? pos : neg,
        }))
      );
      added.push(hist);

      const line = chart.addSeries(
        LineSeries,
        {
          color: CSS("--color-signal-hi", "#7079e0"),
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          title: "MACD",
        },
        idx
      );
      line.setData(toLine(candles, m.macd));
      added.push(line);

      const signal = chart.addSeries(
        LineSeries,
        {
          color: CSS("--color-exposed", "#d9a441"),
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          title: "signal",
        },
        idx
      );
      signal.setData(toLine(candles, m.signal));
      added.push(signal);

      chart.panes()[idx]?.setHeight(90);
    }

    return () => {
      if (dead.current) return;
      for (const s of added) chart.removeSeries(s);
    };
  }, [candles, studies, ready]);

  /* ---------------------------------------------------------------- hover */
  useEffect(() => {
    const chart = chartRef.current;
    const series = priceRef.current;
    if (!chart || !series || !ready || !onHover) return;

    const handler = (param: MouseEventParams) => {
      const bar = param.seriesData.get(series) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      if (!bar || param.time === undefined) return onHover(null);
      onHover({
        time: param.time as number,
        o: bar.open,
        h: bar.high,
        l: bar.low,
        c: bar.close,
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      if (dead.current) return;
      chart.unsubscribeCrosshairMove(handler);
    };
  }, [ready, onHover]);

  const canvas = (
    <div className="relative w-full" style={{ height }}>
      <div ref={host} className="h-full w-full" />
      {drawing ? (
        <DrawingLayer
          chart={chartRef.current}
          series={priceRef.current}
          tool={drawing.tool}
          color={drawing.color}
          drawings={drawing.drawings}
          onCommit={drawing.onCommit}
          selected={drawing.selected}
          onSelect={drawing.onSelect}
          revision={candles.length + (ready ? 1 : 0)}
        />
      ) : null}
    </div>
  );

  if (!frame) return canvas;

  return (
    <div className="raised overflow-hidden">
      <div className="prov-top prov-public px-4 pb-3 pt-4">
        <Prov tone="public">Exposed · public price data</Prov>
      </div>
      {canvas}
    </div>
  );
}

/** The OHLC strip above the chart, tracking the crosshair. */
export function OhlcLegend({
  hover,
  latest,
}: {
  hover: Hover;
  latest: Candle | null;
}) {
  const bar = hover ?? latest;
  if (!bar) return null;
  const up = bar.c >= bar.o;
  const color = up ? "var(--color-pos)" : "var(--color-neg)";
  return (
    <div className="tabular flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
      {hover ? (
        <span className="text-[var(--color-ink-faint)]">
          {new Date((hover.time as number) * 1000).toLocaleString()}
        </span>
      ) : (
        <span className="text-[var(--color-ink-faint)]">last</span>
      )}
      {(
        [
          ["O", bar.o],
          ["H", bar.h],
          ["L", bar.l],
          ["C", bar.c],
        ] as const
      ).map(([k, v]) => (
        <span key={k}>
          <span className="text-[var(--color-ink-faint)]">{k}</span>{" "}
          <span style={{ color }}>{fmtPrice(v)}</span>
        </span>
      ))}
      <span style={{ color }}>
        {bar.o > 0
          ? `${up ? "+" : ""}${(((bar.c - bar.o) / bar.o) * 100).toFixed(2)}%`
          : "—"}
      </span>
    </div>
  );
}
