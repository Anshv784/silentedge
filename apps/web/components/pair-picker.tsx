"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCatalog, POPULAR, type Pair } from "@/lib/market";
import { Badge } from "@/components/ui";

/**
 * Pair switcher over everything Pyth publishes.
 *
 * The catalog is fetched rather than hardcoded, so the list is whatever the
 * publisher actually carries today. Exactly one entry is marked tradable and
 * that flag comes from the vault's compiled-in mints, not from this list — a
 * new listing upstream cannot present itself as something the vault can trade.
 */
export function PairPicker({
  value,
  onChange,
}: {
  value: Pair;
  onChange: (p: Pair) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<Pair[]>(POPULAR);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCatalog().then(setCatalog);
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return catalog.slice(0, 60);
    return catalog.filter((p) => p.base.includes(q)).slice(0, 60);
  }, [catalog, query]);

  return (
    <div className="relative" ref={box}>
      <button
        className="btn btn-ghost gap-2"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="text-[14px] font-semibold">{value.label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-[300px] overflow-hidden rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-panel)] shadow-[0_16px_48px_rgba(0,0,0,0.6)]">
          <div className="border-b border-[var(--color-rule)] p-2">
            <input
              autoFocus
              className="field"
              placeholder={`Search ${catalog.length} pairs…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul className="max-h-[320px] overflow-y-auto py-1">
            {results.length === 0 ? (
              <li className="px-3 py-4 text-center text-[12px] text-[var(--color-ink-faint)]">
                Pyth does not publish a {query} / USD feed.
              </li>
            ) : (
              results.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      onChange(p);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--color-raised)] ${
                      p.id === value.id ? "bg-[var(--color-raised)]" : ""
                    }`}
                  >
                    <span className="truncate">{p.label}</span>
                    {p.tradable ? <Badge tone="good">tradable</Badge> : null}
                  </button>
                </li>
              ))
            )}
          </ul>
          <p className="border-t border-[var(--color-rule)] px-3 py-2 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
            Every pair charts. One trades — the vault&rsquo;s mints are compiled
            into the program, so the rest are analysis only.
          </p>
        </div>
      ) : null}
    </div>
  );
}
