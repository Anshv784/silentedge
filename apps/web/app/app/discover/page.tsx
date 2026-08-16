"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useProgram, followVault, readableError } from "@/lib/vault-program";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  discoverListedVaults,
  readPerformance,
  type ListedVault,
  type VaultPerformance,
} from "@/lib/marketplace";
import { readOraclePrice } from "@/lib/activity";
import { Panel } from "@/components/readouts";
import { QUOTE_SYMBOL, BASE_SYMBOL } from "@silentedge/config";

const PYTH_SOL_USD = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

type Sort = "trades" | "size" | "recent";

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

  return (
    <main className="grid-field min-h-dvh">
      <div className="mx-auto max-w-5xl px-5 pb-24 pt-8 sm:px-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-rule)] pb-6">
          <div>
            <Link href="/" className="text-[15px] font-medium tracking-[0.04em] underline-offset-4 hover:underline">
              SilentEdge
            </Link>
            <p className="mt-1 text-[13px] text-[var(--color-ink-soft)]">
              Vaults whose owners chose to be findable.
            </p>
          </div>
          <nav className="flex items-center gap-4 text-[13px]">
            <Link href="/app" className="underline-offset-4 hover:underline">Vault</Link>
            <Link href="/app/market" className="underline-offset-4 hover:underline">Market</Link>
            <Link href="/app/backtest" className="underline-offset-4 hover:underline">Backtest</Link>
            <span className="text-[var(--color-ink-soft)]">Discover</span>
          </nav>
        </header>

        <div className="mb-5 border border-[var(--color-rule)] bg-[var(--color-panel)] px-4 py-3 text-[12px] leading-relaxed">
          <strong>What you can and cannot learn here.</strong> Everything below
          was already public on chain — balances, risk limits, and executed
          trades. The strategy itself stays encrypted; no instruction in the
          program can export it, so listing a vault reveals nothing new about
          how it decides. Total return is not shown because the vault keeps no
          cost basis and the number would be a guess.
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or address"
            className="min-w-[220px] flex-1 border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2 text-[13px]"
          />
          {(["trades", "size", "recent"] as Sort[]).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              aria-pressed={sort === s}
              className={`border px-3 py-2 text-[12px] ${
                sort === s
                  ? "border-[var(--color-signal)] bg-[var(--color-signal)] text-white"
                  : "border-[var(--color-rule)] hover:bg-[var(--color-paper)]"
              }`}
            >
              {s === "trades" ? "Most traded" : s === "size" ? "Largest" : "Most recent"}
            </button>
          ))}
        </div>

        {followError ? (
          <div className="mb-4 border border-[var(--color-exposed)] px-4 py-3 text-[12px] text-[var(--color-exposed)]">
            {followError}
          </div>
        ) : null}

        {error ? (
          <div className="border border-[var(--color-exposed)] px-4 py-3 text-[12px] text-[var(--color-exposed)]">
            Could not read the chain: {error}
          </div>
        ) : !program ? (
          <p className="text-[13px] text-[var(--color-ink-soft)]">
            Connect a wallet to browse — reading the list needs an RPC connection.
          </p>
        ) : shown === null ? (
          <p className="text-[13px] text-[var(--color-ink-soft)]">Loading vaults…</p>
        ) : shown.length === 0 ? (
          <Panel title="Nothing listed yet" index="—">
            <p className="text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
              {vaults && vaults.length === 0
                ? "No vault has opted into discovery. Listing is off by default: a vault is private to find until its owner says otherwise."
                : "No vault matches that search."}
            </p>
          </Panel>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {shown.map((v) => {
              const p = perf[v.address.toBase58()];
              const value =
                v.quote !== null && v.base !== null && price !== null
                  ? v.quote + v.base * price
                  : null;
              return (
                <li
                  key={v.address.toBase58()}
                  className="border border-[var(--color-rule)] bg-[var(--color-panel)] p-5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-[15px] font-medium">
                      {v.name || "Unnamed vault"}
                    </h2>
                    <span
                      className={`text-[11px] capitalize ${
                        v.status === "active"
                          ? "text-[var(--color-shielded)]"
                          : "text-[var(--color-exposed)]"
                      }`}
                    >
                      {v.status}
                    </span>
                  </div>
                  <p className="tabular mt-1 text-[11px] text-[var(--color-ink-soft)]">
                    by {v.owner.toBase58().slice(0, 4)}…{v.owner.toBase58().slice(-4)}
                  </p>

                  <dl className="tabular mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                    <dt className="text-[var(--color-ink-soft)]">Value</dt>
                    <dd>
                      {value === null
                        ? "—"
                        : `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${QUOTE_SYMBOL}`}
                    </dd>
                    <dt className="text-[var(--color-ink-soft)]">Holdings</dt>
                    <dd>
                      {v.quote?.toFixed(0) ?? "—"} {QUOTE_SYMBOL} ·{" "}
                      {v.base?.toFixed(3) ?? "—"} {BASE_SYMBOL}
                    </dd>
                    <dt className="text-[var(--color-ink-soft)]">Trades</dt>
                    <dd>
                      {p ? `${p.trades} (${p.buys}B / ${p.sells}S)` : "counting…"}
                    </dd>
                    <dt className="text-[var(--color-ink-soft)]">Trading P&L</dt>
                    <dd
                      className={
                        p?.tradingPnlQuote == null
                          ? ""
                          : p.tradingPnlQuote >= 0
                            ? "text-[var(--color-shielded)]"
                            : "text-[var(--color-exposed)]"
                      }
                    >
                      {p?.tradingPnlQuote == null
                        ? "—"
                        : `${p.tradingPnlQuote >= 0 ? "+" : ""}${p.tradingPnlQuote.toFixed(2)} ${QUOTE_SYMBOL}`}
                    </dd>
                    <dt className="text-[var(--color-ink-soft)]">Trade size</dt>
                    <dd>{v.sizeBps / 100}% per trade</dd>
                    <dt className="text-[var(--color-ink-soft)]">Max slippage</dt>
                    <dd>{v.maxSlippageBps / 100}%</dd>
                    <dt className="text-[var(--color-ink-soft)]">Cooldown</dt>
                    <dd>{v.cooldownSeconds}s</dd>
                    <dt className="text-[var(--color-ink-soft)]">Last trade</dt>
                    <dd>
                      {v.lastTradeTs > 0
                        ? new Date(v.lastTradeTs * 1000).toLocaleDateString()
                        : "never"}
                    </dd>
                  </dl>

                  <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-ink-soft)]">
                    Trading P&L is the net effect of this vault&rsquo;s executed
                    trades, summed from on-chain events, valued at the current
                    price. It excludes deposits and withdrawals. It is not a
                    total return and not a prediction.
                  </p>

                  {publicKey && v.owner.toBase58() !== publicKey.toBase58() ? (
                    <div className="mt-3">
                      <button
                        onClick={() => follow(v.address)}
                        disabled={following !== null || v.status !== "active"}
                        className="border border-[var(--color-signal)] bg-[var(--color-signal)] px-3 py-1.5 text-[12px] text-white disabled:opacity-40"
                      >
                        {following === v.address.toBase58()
                          ? "Following…"
                          : followed === v.address.toBase58()
                            ? "Followed"
                            : "Follow this strategy"}
                      </button>
                      <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-soft)]">
                        Copies the encrypted rules into your vault. You will not
                        be able to read them — nobody can, outside the
                        computation. Your own limits, balances and withdrawals
                        stay entirely yours.
                      </p>
                    </div>
                  ) : null}

                  <a
                    className="mt-3 inline-block text-[11px] underline underline-offset-2"
                    href={`https://explorer.solana.com/address/${v.address.toBase58()}?cluster=devnet`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Inspect on chain
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
