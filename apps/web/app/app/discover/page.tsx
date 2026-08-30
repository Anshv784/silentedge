"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useProgram, followVault, readableError } from "@/lib/vault-program";
import {
  discoverListedVaults,
  readPerformance,
  type ListedVault,
  type VaultPerformance,
} from "@/lib/marketplace";
import { readOraclePrice } from "@/lib/activity";
import { QUOTE_SYMBOL, BASE_SYMBOL } from "@silentedge/config";
import {
  Alert,
  Badge,
  Block,
  Gate,
  Mono,
  PageHead,
  Prov,
  REVEAL_ITEM,
  Reveal,
  Row,
  SPRINGS,
  Skeleton,
  Stat,
  Ticking,
} from "@/components/ui";

const PYTH_SOL_USD = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

type Sort = "trades" | "size" | "recent";

const SORTS = [
  ["trades", "Most traded"],
  ["size", "Largest"],
  ["recent", "Most recent"],
] as const;

const round = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const count = (n: number) => String(Math.round(n));

/**
 * Public vault discovery.
 *
 * Two things this page refuses to do, both of which a marketplace usually does.
 *
 * It does not show a total return, because this vault records no cost basis:
 * deposits and withdrawals move either mint without noting what it was worth,
 * so the number cannot be computed from chain state and would have to be
 * guessed. It shows trading performance instead — summed from the program's own
 * TradeExecuted events, excluding deposits and withdrawals by construction —
 * which is exact and says something narrower and true.
 *
 * And it does not show anything about the strategy itself beyond its public
 * risk envelope, because the strategy is encrypted and no instruction in the
 * program can export it. A listing makes a vault findable; it discloses nothing
 * that was not already on chain.
 *
 * Presentation is the lattice: one ruled field, cells sharing hairlines, and
 * every listing carrying the `public` provenance rail — because that is the
 * whole claim of the page, and the rails align down the column to say it once
 * per card without a word. The refusals above are set at reading size rather
 * than in fine print; they are the product, not a footnote to it.
 *
 * Figures are plain text rather than `Ticking`. A listing's value and P&L are
 * read once and do not move, so a spring per cell is a cost with no reading
 * benefit — the same call the market list makes. The two header counts do move
 * as performance streams in, so those tick.
 */
export default function DiscoverPage() {
  const program = useProgram();
  const { connection } = useConnection();

  const [vaults, setVaults] = useState<ListedVault[] | null>(null);
  const [perf, setPerf] = useState<Record<string, VaultPerformance>>({});
  const [price, setPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("trades");
  const { publicKey } = useWallet();
  const [following, setFollowing] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followed, setFollowed] = useState<string | null>(null);

  async function follow(leader: PublicKey) {
    if (!program || !publicKey) return;
    setFollowing(leader.toBase58());
    setFollowError(null);
    try {
      await followVault(program, publicKey, leader);
      setFollowed(leader.toBase58());
    } catch (e) {
      setFollowError(readableError(e));
    } finally {
      setFollowing(null);
    }
  }

  useEffect(() => {
    if (!program) return;
    let alive = true;
    (async () => {
      try {
        const o = await readOraclePrice(connection, PYTH_SOL_USD).catch(() => null);
        if (alive) setPrice(o?.price ?? null);
        const list = await discoverListedVaults(program, connection);
        if (!alive) return;
        setVaults(list);
        for (const v of list) {
          const p = await readPerformance(program, connection, v.address, o?.price ?? null);
          if (!alive) return;
          setPerf((prev) => ({ ...prev, [v.address.toBase58()]: p }));
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [program, connection]);

  const shown = useMemo(() => {
    if (!vaults) return null;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? vaults.filter(
          (v) =>
            v.name.toLowerCase().includes(q) ||
            v.address.toBase58().toLowerCase().startsWith(q) ||
            v.owner.toBase58().toLowerCase().startsWith(q)
        )
      : vaults;
    const withPerf = (v: ListedVault) => perf[v.address.toBase58()]?.trades ?? 0;
    return [...filtered].sort((a, b) => {
      if (sort === "trades") return withPerf(b) - withPerf(a);
      if (sort === "size") return (b.quote ?? 0) - (a.quote ?? 0);
      return b.lastTradeTs - a.lastTradeTs;
    });
  }, [vaults, perf, query, sort]);

  /**
   * The one figure on this screen, and the two counts beside it.
   *
   * Every listing whose token accounts could not be read is left out of the
   * sum rather than treated as zero, and the count of what was actually
   * included is printed under the number — a total that quietly skips rows is
   * the kind of figure this page exists to not show. It is a balance held at
   * one moment, valued at one oracle read. It is not a return.
   */
  const totals = useMemo(() => {
    if (!vaults) return null;
    let valued = 0;
    let sum = 0;
    for (const v of vaults) {
      if (v.quote === null || v.base === null || price === null) continue;
      valued += 1;
      sum += v.quote + v.base * price;
    }
    const trades = vaults.reduce(
      (n, v) => n + (perf[v.address.toBase58()]?.trades ?? 0),
      0
    );
    return { listed: vaults.length, valued, value: valued > 0 ? sum : null, trades };
  }, [vaults, perf, price]);

  return (
    <>
      <PageHead
        title="Discover"
        subtitle="Vaults whose owners chose to be findable"
        actions={
          <Link href="/app/vault" className="btn btn-ghost">
            List your vault
          </Link>
        }
      />

      <Reveal as="div">
        <div className="ledger sm:grid-cols-3">
          <Block>
            <Stat
              figure
              label={`Value in listed vaults · ${QUOTE_SYMBOL}`}
              value={totals?.value == null ? "—" : round(totals.value)}
              loading={vaults === null}
              sub={
                totals === null
                  ? "Reading the listed vaults."
                  : totals.value == null
                    ? `No balance could be valued: the ${BASE_SYMBOL} oracle price or the token accounts could not be read.`
                    : `Summed across ${totals.valued} of ${totals.listed} listings, valued at one ${BASE_SYMBOL} oracle read. A balance held, not a return.`
              }
            />
          </Block>
          <Block>
            <Stat
              label="Vaults listed"
              value={
                totals === null ? (
                  <Skeleton w="3ch" />
                ) : (
                  <Ticking value={totals.listed} format={count} cell />
                )
              }
              sub="Listing is off by default. Every one of these is an owner opting in."
            />
          </Block>
          <Block>
            <Stat
              label="Trades recorded"
              value={
                totals === null ? (
                  <Skeleton w="4ch" />
                ) : (
                  <Ticking value={totals.trades} format={count} cell />
                )
              }
              sub="Counted from the program's own TradeExecuted events, one vault at a time."
            />
          </Block>

          {/* The refusals, at reading size. Wording unchanged from the previous
              build — only the scale and the colour moved. */}
          <Block prov="public" className="sm:col-span-3">
            <Prov tone="public">Exposed · already on chain</Prov>
            <h2 className="mt-4 text-lead font-medium">
              What you can and cannot learn here.
            </h2>
            <p className="mt-3 max-w-[86ch] text-body text-[var(--color-ink-soft)]">
              Everything below was already public on chain — balances, risk
              limits, and executed trades. The strategy itself stays encrypted;
              no instruction in the program can export it, so listing a vault
              reveals nothing new about how it decides. Total return is not
              shown because the vault keeps no cost basis and the number would
              be a guess.
            </p>
          </Block>

          <Block className="sm:col-span-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or address"
                className="field min-w-[220px] flex-1"
              />
              <div className="flex gap-1 rounded bg-[var(--color-raised)] p-1">
                {SORTS.map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setSort(id)}
                    aria-pressed={sort === id}
                    className={`relative rounded px-3 py-1.5 text-[13px] font-medium transition-colors ${
                      sort === id
                        ? "text-[var(--color-ink)]"
                        : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    {sort === id ? (
                      <motion.span
                        aria-hidden
                        layoutId="discover-sort"
                        transition={SPRINGS.snap}
                        className="absolute inset-0 rounded bg-[var(--color-hover)]"
                      />
                    ) : null}
                    <span className="relative">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </Block>
        </div>
      </Reveal>

      <AnimatePresence>
        {followError ? (
          <div key="follow-error" className="mt-8">
            <Alert tone="bad" title="Could not follow.">
              {followError}
            </Alert>
          </div>
        ) : null}
      </AnimatePresence>

      <div className="mt-8">
        {error ? (
          <Alert tone="bad">Could not read the chain: {error}</Alert>
        ) : !program ? (
          <Gate title="Connect a wallet to browse" prov="public">
            Reading the list needs an RPC connection.
          </Gate>
        ) : shown === null ? (
          <div className="ledger sm:grid-cols-2">
            {[0, 1].map((i) => (
              <Block key={i} reveal={false} prov="public">
                <Skeleton w="18ch" />
                <div className="mt-6 space-y-4">
                  {[0, 1, 2, 3].map((r) => (
                    <div key={r}>
                      <Skeleton />
                    </div>
                  ))}
                </div>
                <p className="sr-only">Loading vaults…</p>
              </Block>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <Gate title="Nothing listed yet">
            {vaults && vaults.length === 0
              ? "No vault has opted into discovery. Listing is off by default: a vault is private to find until its owner says otherwise."
              : "No vault matches that search."}
          </Gate>
        ) : (
          <Reveal as="div">
            <ul className="ledger sm:grid-cols-2">
              {shown.map((v) => {
                const key = v.address.toBase58();
                const p = perf[key];
                const value =
                  v.quote !== null && v.base !== null && price !== null
                    ? v.quote + v.base * price
                    : null;
                const active = v.status === "active";
                const pnl = p?.tradingPnlQuote ?? null;
                return (
                  <motion.li
                    key={key}
                    variants={REVEAL_ITEM}
                    /* Every listing is public data, so every card carries the
                       exposed rail. Read down the column, the rails say the
                       same thing the paragraph above says. */
                    className="card prov prov-public"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="min-w-0 text-lead font-medium">
                        {v.name || "Unnamed vault"}
                      </h2>
                      {/* Status is not a number going up or down, so it does
                          not get --color-pos. Accent for running, plain rule
                          for not. */}
                      <Badge tone={active ? "accent" : "neutral"} dot={active}>
                        {v.status[0].toUpperCase() + v.status.slice(1)}
                      </Badge>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="u-label text-[var(--color-ink-faint)]">
                        Owner
                      </span>
                      <Mono copy>{v.owner.toBase58()}</Mono>
                    </div>

                    <div className="mt-7">
                      <div className="u-label text-[var(--color-ink-faint)]">
                        Position
                      </div>
                      <div className="mt-2">
                        <Row
                          label="Value"
                          value={
                            value === null ? "—" : `${round(value)} ${QUOTE_SYMBOL}`
                          }
                        />
                        <Row
                          label="Holdings"
                          value={`${v.quote?.toFixed(0) ?? "—"} ${QUOTE_SYMBOL} · ${
                            v.base?.toFixed(3) ?? "—"
                          } ${BASE_SYMBOL}`}
                        />
                        <Row
                          label="Trades"
                          value={
                            p ? `${p.trades} (${p.buys}B / ${p.sells}S)` : "counting…"
                          }
                        />
                        <Row
                          label="Trading P&L"
                          value={
                            <span
                              className={
                                pnl == null
                                  ? ""
                                  : pnl >= 0
                                    ? "text-[var(--color-pos)]"
                                    : "text-[var(--color-neg)]"
                              }
                            >
                              {pnl == null
                                ? "—"
                                : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ${QUOTE_SYMBOL}`}
                            </span>
                          }
                        />
                      </div>
                    </div>

                    <div className="mt-7">
                      <div className="u-label text-[var(--color-ink-faint)]">
                        Risk envelope
                      </div>
                      <div className="mt-2">
                        <Row
                          label="Trade size"
                          value={`${v.sizeBps / 100}% per trade`}
                        />
                        <Row
                          label="Max slippage"
                          value={`${v.maxSlippageBps / 100}%`}
                        />
                        <Row label="Cooldown" value={`${v.cooldownSeconds}s`} />
                        <Row
                          label="Last trade"
                          value={
                            v.lastTradeTs > 0
                              ? new Date(v.lastTradeTs * 1000).toLocaleDateString()
                              : "never"
                          }
                        />
                      </div>
                    </div>

                    <p className="mt-6 border-t border-[var(--color-rule)] pt-4 text-caption text-[var(--color-ink-soft)]">
                      Trading P&L is the net effect of this vault&rsquo;s
                      executed trades, summed from on-chain events, valued at
                      the current price. It excludes deposits and withdrawals.
                      It is not a total return and not a prediction.
                    </p>

                    {publicKey && v.owner.toBase58() !== publicKey.toBase58() ? (
                      <div className="mt-6">
                        <button
                          onClick={() => follow(v.address)}
                          disabled={following !== null || !active}
                          className="btn btn-primary btn-lg"
                        >
                          {following === key
                            ? "Following…"
                            : followed === key
                              ? "Followed"
                              : "Follow this strategy"}
                        </button>
                        {/* The one shielded thing on a page of public data,
                            marked with the token that means it. */}
                        <div className="mt-4">
                          <Prov tone="private" />
                        </div>
                        <p className="mt-2 max-w-[60ch] text-caption text-[var(--color-ink-soft)]">
                          Copies the encrypted rules into your vault. You will
                          not be able to read them — nobody can, outside the
                          computation. Your own limits, balances and withdrawals
                          stay entirely yours.
                        </p>
                      </div>
                    ) : null}

                    <a
                      className="mt-6 inline-block border-b border-[var(--color-rule-strong)] pb-0.5 text-caption text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
                      href={`https://explorer.solana.com/address/${key}?cluster=devnet`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Inspect on chain →
                    </a>
                  </motion.li>
                );
              })}
            </ul>
          </Reveal>
        )}
      </div>
    </>
  );
}
