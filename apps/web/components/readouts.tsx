"use client";

import { PublicKey } from "@solana/web3.js";

/**
 * Visibility tag.
 *
 * The product's central claim is about what a stranger can and cannot read, so
 * figures carry their answer. These two colours are reserved for this meaning
 * and used nowhere else.
 */
export function Tag({ kind }: { kind: "exposed" | "shielded" }) {
  const exposed = kind === "exposed";
  const color = exposed ? "var(--color-exposed)" : "var(--color-shielded)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11px] font-medium"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
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
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="text-[13px] text-[var(--color-ink-soft)]">{label}</span>
      <span className="tabular text-[14px]">
        {loading || value === null ? (
          <span className="text-[var(--color-ink-faint)]">—</span>
        ) : (
          value.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: unit === "SOL" ? 4 : 2,
          })
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
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className="tabular break-all text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
        {text ?? <span className="text-[var(--color-ink-faint)]">—</span>}
      </div>
    </div>
  );
}

/**
 * A titled card.
 *
 * `index` is accepted and ignored: the numbered-panel chrome it used to render
 * was reference-sheet styling, and the pages that pass it are not worth
 * touching for a prop that now has no visual job.
 */
export function Panel({
  children,
  title,
  index,
  note,
}: {
  children: React.ReactNode;
  title: string;
  index?: string;
  note?: string;
}) {
  void index;
  return (
    <section className="card p-5">
      <h2 className="mb-4 text-[14px] font-medium">{title}</h2>
      {children}
      {note ? (
        <p className="mt-4 border-t border-[var(--color-rule)] pt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          {note}
        </p>
      ) : null}
    </section>
  );
}
