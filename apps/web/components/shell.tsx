"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Ticker } from "@/components/ticker";
import { SPRINGS } from "@/components/ui";

export const WalletButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  {
    ssr: false,
    loading: () => (
      <div className="h-9 w-[132px] rounded bg-[var(--color-panel)]" />
    ),
  }
);

const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";

type Item = { href: string; label: string; icon: ReactNode };

const I = (d: string) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d={d}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const NAV: { group: string; items: Item[] }[] = [
  {
    group: "Trade",
    items: [
      { href: "/app", label: "Overview", icon: I("M2 9.5h4v4H2zM6.5 2.5h3v11h-3zM10 6.5h4v7h-4z") },
      { href: "/app/strategy", label: "Strategy", icon: I("M2 12l3.5-4 2.5 2.5L13.5 4M13.5 4H10m3.5 0v3.5") },
      { href: "/app/vault", label: "Vault", icon: I("M2.5 5.5h11v8h-11zM2.5 5.5l5.5-3 5.5 3M8 8.5v2.5") },
    ],
  },
  {
    group: "Research",
    items: [
      { href: "/app/market", label: "Terminal", icon: I("M2 13.5V6M6 13.5V2.5M10 13.5V8M14 13.5v-9") },
      { href: "/app/markets", label: "Markets", icon: I("M2.5 4h11M2.5 8h11M2.5 12h11M5 2.5v11") },
      { href: "/app/backtest", label: "Backtest", icon: I("M8 2.5a5.5 5.5 0 1 0 5.5 5.5M8 5v3l2 1.5M13.5 2.5v3.5H10") },
      { href: "/app/discover", label: "Discover", icon: I("M7.25 12.5a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5zM11 11l3 3") },
      { href: "/app/portfolio", label: "Portfolio", icon: I("M2.5 5h11v8.5h-11zM5.5 5V3.5h5V5") },
    ],
  },
];

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
        <rect width="20" height="20" rx="5" fill="var(--color-signal)" />
        <path
          d="M6 12.6c.9.8 2 1.2 3.4 1.2 1.9 0 3-.8 3-2 0-1.1-.8-1.6-2.6-2l-1-.2C7 9.1 6.1 8.2 6.1 6.8c0-1.7 1.4-2.8 3.6-2.8 1.3 0 2.4.3 3.2 1"
          stroke="var(--color-on-signal)"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <span className="text-[15px] font-medium tracking-[-0.01em]">
        SilentEdge
      </span>
    </Link>
  );
}

/**
 * The persistent visibility legend.
 *
 * The exposed/shielded pair is the product's whole axis, and every screen
 * labels values with it. Stating what the two colours mean, once, in the
 * chrome, is what turns a coloured rule into a readable claim rather than
 * decoration.
 */
function Legend() {
  return (
    <div className="hidden items-center gap-4 xl:flex">
      {(
        [
          ["var(--color-exposed)", "Exposed"],
          ["var(--color-shielded)", "Shielded"],
        ] as const
      ).map(([c, label]) => (
        <span
          key={label}
          className="u-label flex items-center gap-1.5 text-[var(--color-ink-faint)]"
        >
          <span
            aria-hidden
            className="inline-block h-2 w-2"
            style={{ background: c }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * The application shell.
 *
 * It lives in `app/app/layout.tsx` rather than inside each page, which is what
 * makes its motion real: the sidebar's `layoutId` pill can only slide if both
 * the old and the new row are mounted at the same time, and that only happens
 * when the sidebar survives the navigation. While the shell was re-mounted per
 * page, the pill blinked out and back in, and a 15-line `AnimatePresence` on
 * the header title could never run at all.
 *
 * The shell holds no page identity. A page title at body weight inside a
 * sticky bar is a breadcrumb, not a heading — identity now belongs to the
 * content column, at `--text-title`. See `PageHead`.
 */
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  // Exact match plus a trailing slash, not a bare prefix: /app/markets is a
  // sibling of /app/market, and `startsWith` lights both rows at once.
  const active = (href: string) => path === href || path.startsWith(`${href}/`);

  const sidebar = (id: string) => (
    <>
      <div className="flex h-16 items-center px-5">
        <Brand />
      </div>
      <nav className="flex-1 space-y-7 px-3 py-3">
        {NAV.map((section) => (
          <div key={section.group}>
            <div className="u-label px-3 pb-2 text-[var(--color-ink-faint)]">
              {section.group}
            </div>
            {section.items.map((item) => {
              const on = active(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`relative flex items-center gap-3 px-3 py-2 text-[15px] transition-colors ${
                    on
                      ? "text-[var(--color-ink)]"
                      : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  {/* One rule, shared across every row via `layoutId`, so it
                      travels from the old item to the new one. A 2px rule
                      rather than a filled pill: the ruled register marks
                      position with a line, and it costs no surface. */}
                  {on ? (
                    <motion.span
                      layoutId={`nav-active-${id}`}
                      className="absolute inset-y-0 left-0 w-[2px]"
                      style={{ background: "var(--color-signal)" }}
                      transition={SPRINGS.snap}
                    />
                  ) : null}
                  <span
                    className={`relative ${on ? "text-[var(--color-signal-hi)]" : ""}`}
                  >
                    {item.icon}
                  </span>
                  <span className="relative">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-[var(--color-rule)] px-5 py-4">
        {/* A static square. This states a fixed fact about the deployment, so
            a pulsing "live" indicator would be animating a constant. */}
        <div className="u-label flex items-center gap-2 text-[var(--color-exposed)]">
          <span
            className="h-2 w-2 shrink-0 bg-[var(--color-exposed)]"
            aria-hidden
          />
          {NETWORK} · unaudited
        </div>
        <a
          className="mt-2 inline-block text-caption text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink-soft)] hover:underline"
          href="https://github.com/Anshv784/silentedge"
          target="_blank"
          rel="noreferrer noopener"
        >
          Source &amp; security notes
        </a>
      </div>
    </>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      {/* desktop rail — on `paper` with a rule, not a raised slab. The slab
          spent an elevation step on furniture. */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-[var(--color-rule)] lg:flex">
        {sidebar("rail")}
      </aside>

      {/* mobile drawer */}
      <AnimatePresence>
        {open ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0 bg-black/70"
              onClick={() => setOpen(false)}
              aria-hidden
            />
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 460, damping: 42 }}
              // Dismissable by dragging, which is what a drawer on a phone is
              // expected to do. Velocity is considered as well as distance, so
              // a fast short flick closes it.
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={{ left: 0.6, right: 0 }}
              onDragEnd={(_, info) => {
                if (info.offset.x < -60 || info.velocity.x < -420) setOpen(false);
              }}
              className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-[var(--color-rule)] bg-[var(--color-paper)]"
            >
              {sidebar("drawer")}
            </motion.aside>
          </div>
        ) : null}
      </AnimatePresence>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-[var(--color-rule)] bg-[color-mix(in_srgb,var(--color-paper)_85%,transparent)] px-4 backdrop-blur-md sm:px-6">
          <button
            className="btn btn-ghost h-9 w-9 !px-0 lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
          >
            {I("M2.5 4.5h11M2.5 8h11M2.5 11.5h11")}
          </button>
          <Legend />
          <div className="flex-1" />
          <WalletButton />
        </header>
        <Ticker />
        {/*
          No fade on the main region. Every block inside already animates in on
          scroll, and animating the container as well double-composites the
          same pixels — the page reads as slower, not smoother.
        */}
        <main className="px-4 pb-24 pt-8 sm:px-6 lg:px-10">{children}</main>
      </div>
    </div>
  );
}
