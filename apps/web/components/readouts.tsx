"use client";

import { PublicKey } from "@solana/web3.js";

/**
 * Visibility tag.
 *
 * The product's central claim is about what a stranger can and cannot read, so
 * every figure on this page carries its answer. These two colours are reserved
 * for this meaning and used nowhere else.
 */
export function Tag({ kind }: { kind: "exposed" | "shielded" }) {
  const exposed = kind === "exposed";
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em]"
      style={{ color: exposed ? "var(--color-exposed)" : "var(--color-shielded)" }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: "currentColor",
          boxShadow: exposed ? "none" : "0 0 0 2px color-mix(in srgb, currentColor 25%, transparent)",
        }}
      />
      {exposed ? "Public" : "Shielded"}
    </span>
  );
}

export function Figure({
  label,
  value,
  unit,
  loading,
}: {
  label: string;
  value: number | null;
  unit: string;
  loading?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <span className="text-[13px] text-[var(--color-ink-soft)]">{label}</span>
      <span className="tabular text-[15px]">
        {loading || value === null ? (
          <span className="text-[var(--color-ink-soft)]">—</span>
        ) : (
          <>
            {value.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: unit === "SOL" ? 4 : 2,
            })}
          </>
        )}
      </span>
    </div>
  );
}

export function Address({
  value,
  label,
}: {
  value: PublicKey | string | null;
  label: string;
}) {
  const text = value?.toString() ?? null;
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-soft)]">
        {label}
      </div>
      <div className="tabular break-all text-[12px] leading-relaxed">
        {text ?? <span className="text-[var(--color-ink-soft)]">—</span>}
      </div>
    </div>
  );
}

export function Panel({
  children,
  title,
  index,
  note,
}: {
  children: React.ReactNode;
  title: string;
  index: string;
  note?: string;
}) {
  return (
    <section className="border border-[var(--color-rule)] bg-[var(--color-panel)]">
      <header className="flex items-baseline justify-between border-b border-[var(--color-rule)] px-5 py-3">
        <h2 className="text-[13px] font-medium tracking-[0.02em]">{title}</h2>
        <span className="tabular text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-soft)]">
          {index}
        </span>
      </header>
      <div className="px-5 py-4">{children}</div>
      {note ? (
        <footer className="border-t border-[var(--color-rule)] px-5 py-2.5 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
          {note}
        </footer>
      ) : null}
    </section>
  );
}
