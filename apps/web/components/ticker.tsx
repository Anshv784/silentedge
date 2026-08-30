"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { POPULAR, price as fmtPrice } from "@/lib/market";
import { fetchFeeds, fetchQuotes, type Feed } from "@/lib/pyth";

type Tick = { base: string; last: number; changePct: number | null; tradable: boolean };

/** The pairs on the tape. Enough to fill it twice without a request storm. */
const TAPE = POPULAR.slice(0, 14).map((p) => p.base);

/**
 * The tape.
 *
 * Real prices, batched: all fourteen feeds arrive in two Hermes requests
 * rather than fourteen benchmarks requests, which is what stopped the earlier
 * version from getting rate-limited into a row of dashes. Refreshed on a slow
 * interval, because a tape that re-requests every few seconds is decoration
 * billed to the user's bandwidth.
 *
 * It renders nothing until it has data. A tape scrolling placeholders reads as
 * a broken market rather than as a loading state.
 */
export function Ticker() {
  const [ticks, setTicks] = useState<Tick[] | null>(null);

  useEffect(() => {
    let alive = true;
    let feeds: Feed[] | null = null;

    const load = async () => {
      try {
        if (!feeds) {
          const all = await fetchFeeds();
          const want = new Set(TAPE);
          const bySymbol = new Map(all.map((f) => [f.base, f]));
          feeds = TAPE.map((b) => bySymbol.get(b)).filter(
            (f): f is Feed => !!f && want.has(f.base)
          );
        }
        const quotes = await fetchQuotes(feeds);
        if (!alive) return;
        const rows: Tick[] = [];
        for (const f of feeds) {
          const q = quotes.get(f.id);
          if (!q) continue;
          rows.push({
            base: f.base,
            last: q.last,
            changePct: q.changePct,
            tradable: POPULAR.some((p) => p.base === f.base && p.tradable),
          });
        }
        if (rows.length > 0) setTicks(rows);
      } catch {
        // A tape that fails is a tape that does not render. Nothing else on
        // the page depends on it.
      }
    };

    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!ticks) return null;

  // Rendered twice so the -50% translation loops without a visible seam.
  const run = [...ticks, ...ticks];

  return (
    <div className="group relative overflow-hidden border-b border-[var(--color-rule)] bg-[var(--color-panel)]">
      <div className="tape flex w-max gap-8 py-2">
        {run.map((t, i) => {
          const up = (t.changePct ?? 0) >= 0;
          return (
            <Link
              key={`${t.base}-${i}`}
              href={`/app/market?pair=${t.base}`}
              className="flex shrink-0 items-center gap-2 px-1 text-[12px] transition-opacity hover:opacity-70"
              // The duplicated half is presentational; only the first pass is
              // reachable by a screen reader or the keyboard.
              aria-hidden={i >= ticks.length}
              tabIndex={i >= ticks.length ? -1 : undefined}
            >
              <span
                className={
                  t.tradable
                    ? "font-medium text-[var(--color-signal-hi)]"
                    : "font-medium text-[var(--color-ink-soft)]"
                }
              >
                {t.base}
              </span>
              <span className="tabular text-[var(--color-ink)]">
                {fmtPrice(t.last)}
              </span>
              {t.changePct === null ? null : (
                <span
                  className="tabular"
                  style={{
                    color: up ? "var(--color-pos)" : "var(--color-neg)",
                  }}
                >
                  {up ? "▲" : "▼"}
                  {Math.abs(t.changePct).toFixed(2)}%
                </span>
              )}
            </Link>
          );
        })}
      </div>
      {/* Fade the ends so entries appear and leave rather than being clipped. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[var(--color-panel)] to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--color-panel)] to-transparent"
      />
    </div>
  );
}
