"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Alert,
  Badge,
  Block,
  PageHead,
  Prov,
  REVEAL_ITEM,
  Reveal,
  SPRINGS,
  Skeleton,
  Stat,
  Ticking,
} from "@/components/ui";
import { fetchQuotes, type Feed, type Quote } from "@/lib/pyth";
import {
  TRADABLE,
  fetchCatalog,
  price as fmtPrice,
  type Pair,
} from "@/lib/market";

/**
 * The market list.
 *
 * Every crypto/USD pair Pyth publishes, searchable, with a real price and a
 * real 24-hour change — the change computed here from two batched observations
 * (now, and a fixed timestamp a day back) rather than read off a summary field.
 *
 * The visible page is two requests regardless of how many rows it holds,
 * because Hermes takes sixty feed ids at once. Only the visible page is
 * quoted: Hermes rate-limits as well, and asking for all five hundred pairs
 * twice every refresh is twenty requests a cycle, which earns a 429 and a
 * table of dashes. So the ranking is over the rows actually quoted, and the UI
 * says so rather than implying it ranked the whole market.
 *
 * Presentation is the lattice register: one ruled field, cells sharing
 * hairlines, uppercase column heads and 15px mono figures. Prices are plain
 * text rather than `Ticking` — the list can hold four hundred rows and eight
 * hundred springs to flash a value that refreshes every 45 seconds is a cost
 * with no reading benefit. The tick flash belongs on the terminal.
 */

const PAGE_SIZE = 50;

type Sort = "default" | "gainers" | "losers";

const FILTERS = [
  ["default", "All"],
  ["gainers", "Gainers"],
  ["losers", "Losers"],
] as const;

const count = (n: number) => String(Math.round(n));

export default function Markets() {
  const [catalog, setCatalog] = useState<Pair[] | null>(null);
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("default");
  const [shown, setShown] = useState(PAGE_SIZE);

  useEffect(() => {
    fetchCatalog().then(setCatalog);
  }, []);

  /* The rows on screen, in catalog order — the set that gets quoted. Sorting
     happens after, over these, so the quote set never depends on the ordering
     that depends on the quotes. */
  const pool = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toUpperCase();
    const matched = q ? catalog.filter((p) => p.base.includes(q)) : catalog;
    return matched;
  }, [catalog, query]);

  const inView = useMemo(() => pool.slice(0, shown), [pool, shown]);

  /* Quote what is on screen, and only that. Two batched requests per refresh
     regardless of row count; previously-fetched quotes are kept, so paging
     accumulates rather than re-asking for rows already in hand. */
  useEffect(() => {
    const feeds: Feed[] = inView
      .filter((p) => p.feedId)
      .map((p) => ({
        id: p.feedId!,
        symbol: p.id,
        base: p.base,
        description: p.label,
      }));
    if (feeds.length === 0) {
      if (catalog) {
        setLoading(false);
        setError(
          catalog.some((p) => p.feedId)
            ? null
            : "The pair catalog could not be read, so only the built-in shortlist is shown."
        );
      }
      return;
    }
    let alive = true;
    setLoading(true);
    const merge = (q: Map<string, Quote>) => {
      if (!alive) return;
      setQuotes((prev) => new Map([...prev, ...q]));
    };
    const load = () =>
      // Prices render as soon as the "latest" pass lands; the 24-hour column
      // fills in behind it, because that pass is slower and partially fails by
      // design for feeds with no history.
      fetchQuotes(feeds, (partial) => {
        merge(partial);
        if (alive) setLoading(false);
      })
        .then((q) => {
          merge(q);
          if (alive) {
            setError(q.size === 0 ? "Pyth returned no prices just now." : null);
          }
        })
        .catch((e) => alive && setError(String(e?.message ?? e)))
        .finally(() => alive && setLoading(false));
    load();
    const id = setInterval(load, 45_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [inView, catalog]);

  useEffect(() => setShown(PAGE_SIZE), [query, sort]);

  const visible = useMemo(() => {
    if (sort === "default") return inView;
    // Unquoted rows sort last rather than sorting as zero, which would park
    // them in the middle of the ranking as though they were flat.
    const key = (p: Pair) => {
      const c = p.feedId ? quotes.get(p.feedId)?.changePct : undefined;
      return c ?? (sort === "gainers" ? -Infinity : Infinity);
    };
    return [...inView].sort((a, b) =>
      sort === "gainers" ? key(b) - key(a) : key(a) - key(b)
    );
  }, [inView, sort, quotes]);

  const quotedHere = inView.filter(
    (p) => p.feedId && quotes.get(p.feedId)?.changePct != null
  ).length;

  /* Counted, not asserted: `tradable` is set in the catalog against the
     vault's own pair, so this cannot drift if a listing changes upstream. */
  const tradable = catalog?.filter((p) => p.tradable).length ?? 0;

  return (
    <>
      <PageHead
        title="Markets"
        subtitle={
          catalog
            ? "Every crypto/USD pair Pyth publishes, searchable. The 24-hour change is computed here from two observations, not read off a summary field."
            : "Loading the pair catalog…"
        }
        actions={
          <Link href="/app/market" className="btn btn-ghost">
            Open terminal
          </Link>
        }
      />

      <Reveal as="div">
        <div className="ledger sm:grid-cols-3">
          {/* The one figure on this screen. */}
          <Block>
            <Stat
              label="Pairs in the catalog"
              value={catalog?.length ?? 0}
              loading={!catalog}
              figure
              sub="Read from the Pyth feed catalog when the page loads."
            />
          </Block>
          <Block>
            <Stat
              label="Quoted on this screen"
              value={<Ticking value={quotes.size} format={count} />}
              sub={`Only the rows in view are quoted, ${PAGE_SIZE} at a time.`}
            />
          </Block>
          <Block>
            <Stat
              label="Tradable by this vault"
              value={catalog ? tradable : <Skeleton w="2ch" />}
              sub={`${TRADABLE.base} / USD. Every other pair charts but does not trade.`}
            />
          </Block>

          {/* ------------------------------------------------------ controls */}
          <Block className="sm:col-span-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                className="field min-w-[220px] flex-1"
                placeholder="Search by symbol — BTC, JUP, BONK…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="flex gap-1 rounded bg-[var(--color-raised)] p-1">
                {FILTERS.map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setSort(id)}
                    className={`relative rounded px-3 py-1.5 text-[13px] font-medium transition-colors ${
                      sort === id
                        ? "text-[var(--color-ink)]"
                        : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    {sort === id ? (
                      <motion.span
                        aria-hidden
                        layoutId="markets-filter"
                        transition={SPRINGS.snap}
                        className="absolute inset-0 rounded bg-[var(--color-hover)]"
                      />
                    ) : null}
                    <span className="relative">{label}</span>
                  </button>
                ))}
              </div>
            </div>
            {sort !== "default" ? (
              <p className="mt-4 max-w-[80ch] text-caption text-[var(--color-ink-soft)]">
                Ranked across the {quotedHere} rows on screen, not all{" "}
                {catalog?.length ?? 0} pairs — quoting the whole catalog every
                refresh is twenty requests a cycle and earns a rate limit. Load
                more rows to widen the ranking.
              </p>
            ) : null}
            {error ? (
              <div className="mt-4">
                <Alert tone="warn">{error}</Alert>
              </div>
            ) : null}
          </Block>

          {/* --------------------------------------------------------- table
              `p-0 pl-6` keeps the 24px the provenance rule needs and hands the
              rest of the padding to the cells, so a row's hover reaches the
              full width of the block instead of stopping inside a gutter. */}
          <Block
            prov="public"
            className="p-0 pl-6 hover:bg-[var(--color-paper)] sm:col-span-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5">
              <Prov tone="public">Exposed · public price data</Prov>
              <span className="u-label text-[var(--color-ink-soft)]">
                {catalog ? `${pool.length} matching` : "Loading"}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px]">
                <thead>
                  <tr className="border-y border-[var(--color-rule)]">
                    <th className="u-label px-5 py-3 text-left text-[var(--color-ink-soft)]">
                      Pair
                    </th>
                    <th className="u-label hidden px-5 py-3 text-left text-[var(--color-ink-soft)] md:table-cell">
                      Name
                    </th>
                    <th className="u-label px-5 py-3 text-right text-[var(--color-ink-soft)]">
                      Price
                    </th>
                    <th className="u-label px-5 py-3 text-right text-[var(--color-ink-soft)]">
                      24h
                    </th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-rule)]">
                  {catalog === null
                    ? Array.from({ length: 12 }, (_, i) => (
                        <tr key={i}>
                          <td className="px-5 py-4" colSpan={5}>
                            <Skeleton />
                          </td>
                        </tr>
                      ))
                    : visible.map((p) => {
                        const q = p.feedId ? quotes.get(p.feedId) : undefined;
                        const change = q?.changePct ?? null;
                        const up = change === null ? true : change >= 0;
                        const color = up
                          ? "var(--color-pos)"
                          : "var(--color-neg)";
                        return (
                          <tr
                            key={p.id}
                            className="transition-colors duration-200 hover:bg-[var(--color-panel)]"
                          >
                            <td className="px-5 py-4">
                              <Link
                                href={`/app/market?pair=${encodeURIComponent(p.base)}`}
                                className="flex items-center gap-2"
                              >
                                <span className="tabular text-[15px] font-medium">
                                  {p.base}
                                </span>
                                <span className="text-caption text-[var(--color-ink-faint)]">
                                  /USD
                                </span>
                                {p.tradable ? (
                                  <Badge tone="good">tradable</Badge>
                                ) : null}
                              </Link>
                            </td>
                            <td className="hidden max-w-[240px] truncate px-5 py-4 text-caption text-[var(--color-ink-soft)] md:table-cell">
                              {p.label}
                            </td>
                            <td className="tabular px-5 py-4 text-right text-[15px]">
                              {q ? (
                                `$${fmtPrice(q.last)}`
                              ) : loading ? (
                                <Skeleton w="7ch" />
                              ) : (
                                <span className="text-caption text-[var(--color-ink-faint)]">
                                  no data
                                </span>
                              )}
                            </td>
                            <td
                              className="tabular px-5 py-4 text-right text-[15px]"
                              style={{
                                color: change !== null ? color : undefined,
                              }}
                            >
                              {change !== null ? (
                                `${up ? "+" : ""}${change.toFixed(2)}%`
                              ) : loading ? (
                                <Skeleton w="5ch" />
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="px-5 py-4 text-right">
                              <Link
                                href={`/app/market?pair=${encodeURIComponent(p.base)}`}
                                className="text-caption text-[var(--color-signal-hi)] underline-offset-2 hover:underline"
                              >
                                Chart
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            </div>

            {catalog !== null && pool.length === 0 ? (
              <p className="px-5 py-14 text-center text-caption text-[var(--color-ink-soft)]">
                Pyth does not publish a {query.toUpperCase()} / USD feed.
              </p>
            ) : null}

            {catalog !== null && shown < pool.length ? (
              <div className="border-t border-[var(--color-rule)] px-5 py-5 text-center">
                <button
                  className="btn btn-ghost"
                  onClick={() => setShown((n) => n + PAGE_SIZE)}
                >
                  Show {Math.min(PAGE_SIZE, pool.length - shown)} more · {shown}{" "}
                  of {pool.length}
                </button>
              </div>
            ) : null}
          </Block>
        </div>

        {/* The provenance note. Word for word what it was — this paragraph is
            the reason the table is trustworthy, and it only changed size. */}
        <motion.p
          variants={REVEAL_ITEM}
          className="mt-8 max-w-[86ch] text-caption text-[var(--color-ink-soft)]"
        >
          Pyth put every live-price endpoint behind an API key on 26 August
          2026, so prices are derived on our server from the one history
          endpoint still open: the newest hourly close, against the close
          nearest twenty-four hours before it. There is no confidence column
          because that number is only published on the endpoints now requiring
          auth, and inventing one would be worse than omitting it. No volume
          column, because Pyth publishes prices and not trades, and no sparkline
          column, because a chart per row means a request per row against an
          endpoint that rate-limits — the terminal is one click away instead.
          Every pair charts; one trades, because the vault&rsquo;s two mints are
          compiled into the program.
        </motion.p>
      </Reveal>
    </>
  );
}
