"use client";

import type { Receipt } from "./vault-actions";

const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";
const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "http://127.0.0.1:8899";

/**
 * Explorer link. A local fork is not a public cluster, so it needs the
 * custom-RPC form or the link goes nowhere.
 */
function explorerUrl(signature: string): string {
  const isLocal = /127\.0\.0\.1|localhost/.test(RPC);
  const query = isLocal
    ? `?cluster=custom&customUrl=${encodeURIComponent(RPC)}`
    : `?cluster=${CLUSTER}`;
  return `https://explorer.solana.com/tx/${signature}${query}`;
}

export function Receipts({ items }: { items: Receipt[] }) {
  if (items.length === 0) return null;

  return (
    <section className="card">
      <header className="flex items-baseline justify-between border-b border-[var(--color-rule)] px-5 py-3">
        <h2 className="text-[14px] font-medium">This session</h2>
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
          Receipts
        </span>
      </header>
      <ul className="divide-y divide-[var(--color-rule)]">
        {items.map((r) => (
          <li
            key={r.signature}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3"
          >
            <span className="text-[13px]">{r.action}</span>
            <a
              href={explorerUrl(r.signature)}
              target="_blank"
              rel="noreferrer"
              className="tabular break-all text-[11px] text-[var(--color-signal-hi)] underline underline-offset-2"
            >
              {r.signature.slice(0, 12)}…{r.signature.slice(-12)}
            </a>
          </li>
        ))}
      </ul>
      <footer className="border-t border-[var(--color-rule)] px-5 py-2.5 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        Every action is a Solana transaction. Verify each one yourself — these
        links go to the explorer, not to us.
      </footer>
    </section>
  );
}
