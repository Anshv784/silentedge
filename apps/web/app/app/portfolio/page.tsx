"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useVault } from "@/lib/use-vault";
import { useProgram, readExposureLimits, readLimits } from "@/lib/vault-program";
import { readActivity, readOraclePrice, type Activity } from "@/lib/activity";
import { readPerformance, type VaultPerformance } from "@/lib/marketplace";
import { Panel } from "@/components/readouts";
import { QUOTE_SYMBOL, BASE_SYMBOL } from "@silentedge/config";

const PYTH_SOL_USD = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

const fmt = (n: number | null, dp = 2) =>
  n === null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: dp });

/**
 * The portfolio view.
 *
 * Every figure carries where it came from, because they are not equally solid:
 * a token balance is a fact, a value in quote terms depends on an oracle read,
 * and anything resembling profit depends on information this protocol
 * deliberately does not keep.
 *
 * There is no total return here, and that absence is the considered part. The
 * vault records no cost basis — deposits and withdrawals move either mint
 * without noting what it was worth — so a return figure would have to be
 * estimated, and an estimate rendered next to real balances reads as a
 * measurement. Trading P&L is shown instead: summed from the program's own
 * TradeExecuted events, excluding deposits and withdrawals by construction. It
 * is exact, and it answers a narrower question honestly.
 */
export default function PortfolioPage() {
  const program = useProgram();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const v = useVault();

  const [price, setPrice] = useState<number | null>(null);
  const [perf, setPerf] = useState<VaultPerformance | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [exposure, setExposure] = useState<{ maxBaseExposureBps: number; minTradeBps: number } | null>(null);
  const [limits, setLimits] = useState<Awaited<ReturnType<typeof readLimits>>>(null);

  useEffect(() => {
    if (!program || !publicKey || !v.vaultAddress) return;
    let alive = true;
    const load = async () => {
      const o = await readOraclePrice(connection, PYTH_SOL_USD).catch(() => null);
      if (!alive) return;
      setPrice(o?.price ?? null);
      const [p, a, e, l] = await Promise.all([
        readPerformance(program, connection, v.vaultAddress!, o?.price ?? null).catch(() => null),
        readActivity(connection, v.vaultAddress!, 15).catch(() => [] as Activity[]),
        readExposureLimits(program, publicKey).catch(() => null),
        readLimits(program, publicKey).catch(() => null),
      ]);
      if (!alive) return;
      setPerf(p);
      setActivity(a);
      setExposure(e);
      setLimits(l);
    };
    load();
    const id = setInterval(load, 25_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [program, publicKey, connection, v.vaultAddress]);

  const vaultValue =
    v.vaultUsdc !== null && v.vaultWrappedSol !== null && price !== null
      ? v.vaultUsdc + v.vaultWrappedSol * price
      : null;
  const walletValue =
    v.walletUsdc !== null && v.walletSol !== null && price !== null
      ? v.walletUsdc + v.walletSol * price
      : null;
  const total =
    vaultValue !== null && walletValue !== null ? vaultValue + walletValue : null;

  const baseValue =
    v.vaultWrappedSol !== null && price !== null ? v.vaultWrappedSol * price : null;
  const basePct =
    baseValue !== null && vaultValue !== null && vaultValue > 0
      ? (baseValue / vaultValue) * 100
      : null;

  return (
    <main className="grid-field min-h-dvh">
      <div className="mx-auto max-w-5xl px-5 pb-24 pt-8 sm:px-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-rule)] pb-6">
          <div>
            <Link href="/" className="text-[15px] font-medium tracking-[0.04em] underline-offset-4 hover:underline">
              SilentEdge
            </Link>
            <p className="mt-1 text-[13px] text-[var(--color-ink-soft)]">
              What you hold, and where each number comes from.
            </p>
          </div>
          <nav className="flex flex-wrap items-center gap-4 text-[13px]">
            <Link href="/app" className="underline-offset-4 hover:underline">Vault</Link>
            <Link href="/app/market" className="underline-offset-4 hover:underline">Market</Link>
            <Link href="/app/backtest" className="underline-offset-4 hover:underline">Backtest</Link>
            <Link href="/app/discover" className="underline-offset-4 hover:underline">Discover</Link>
            <span className="text-[var(--color-ink-soft)]">Portfolio</span>
          </nav>
        </header>

        {!publicKey ? (
          <p className="text-[13px] text-[var(--color-ink-soft)]">
            Connect a wallet to see your holdings.
          </p>
        ) : !v.vaultAddress ? (
          <Panel title="No vault yet" index="—">
            <p className="text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
              You have not created a vault. Your wallet balances are still shown
              below; nothing is being traded.
            </p>
          </Panel>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Total value" index="01" note="Balances are on-chain; the conversion is oracle-derived.">
            <div className="tabular text-[28px]">
              {v.loading ? "…" : total === null ? "unavailable" : `${fmt(total)} ${QUOTE_SYMBOL}`}
            </div>
            <dl className="tabular mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
              <dt className="text-[var(--color-ink-soft)]">In the vault</dt>
              <dd>{fmt(vaultValue)} {QUOTE_SYMBOL}</dd>
              <dt className="text-[var(--color-ink-soft)]">In your wallet</dt>
              <dd>{fmt(walletValue)} {QUOTE_SYMBOL}</dd>
              <dt className="text-[var(--color-ink-soft)]">Price used</dt>
              <dd>{price === null ? "—" : `$${price.toFixed(2)}`}</dd>
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
              Only the vault is traded. Wallet balances are shown because they
              are yours, not because anything acts on them.
            </p>
          </Panel>

          <Panel title="Allocation" index="02" note="On-chain balances, valued at the oracle price.">
            <dl className="tabular grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
              <dt className="text-[var(--color-ink-soft)]">{QUOTE_SYMBOL}</dt>
              <dd>{fmt(v.vaultUsdc)} </dd>
              <dt className="text-[var(--color-ink-soft)]">{BASE_SYMBOL}</dt>
              <dd>{fmt(v.vaultWrappedSol, 4)}</dd>
              <dt className="text-[var(--color-ink-soft)]">In {BASE_SYMBOL}</dt>
              <dd>{basePct === null ? "—" : `${basePct.toFixed(1)}% of the vault`}</dd>
              <dt className="text-[var(--color-ink-soft)]">Exposure ceiling</dt>
              <dd>
                {exposure === null
                  ? "—"
                  : exposure.maxBaseExposureBps === 0
                    ? "none set"
                    : `${exposure.maxBaseExposureBps / 100}%`}
              </dd>
            </dl>
            {exposure && exposure.maxBaseExposureBps > 0 && basePct !== null ? (
              <div className="mt-3">
                <div className="h-1.5 w-full bg-[var(--color-rule)]">
                  <div
                    className="h-1.5 bg-[var(--color-signal)]"
                    style={{
                      width: `${Math.min(100, (basePct / (exposure.maxBaseExposureBps / 100)) * 100).toFixed(1)}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--color-ink-soft)]">
                  New entries are refused once this fills. Exits are never
                  blocked by it.
                </p>
              </div>
            ) : null}
          </Panel>

          <Panel title="Trading performance" index="03" note="Summed from the program's own trade events. Exact.">
            {perf === null ? (
              <p className="text-[12px] text-[var(--color-ink-soft)]">Reading trade history…</p>
            ) : perf.trades === 0 ? (
              <p className="text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
                No trades yet. Nothing to measure — this is an empty history, not
                a zero return.
              </p>
            ) : (
              <dl className="tabular grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
                <dt className="text-[var(--color-ink-soft)]">Trades</dt>
                <dd>{perf.trades} ({perf.buys} buy / {perf.sells} sell)</dd>
                <dt className="text-[var(--color-ink-soft)]">Net {QUOTE_SYMBOL} from trading</dt>
                <dd>{perf.netQuote >= 0 ? "+" : ""}{fmt(perf.netQuote)}</dd>
                <dt className="text-[var(--color-ink-soft)]">Net {BASE_SYMBOL} from trading</dt>
                <dd>{perf.netBase >= 0 ? "+" : ""}{fmt(perf.netBase, 4)}</dd>
                <dt className="text-[var(--color-ink-soft)]">Trading P&L</dt>
                <dd
                  className={
                    perf.tradingPnlQuote == null
                      ? ""
                      : perf.tradingPnlQuote >= 0
                        ? "text-[var(--color-shielded)]"
                        : "text-[var(--color-exposed)]"
                  }
                >
                  {perf.tradingPnlQuote == null
                    ? "—"
                    : `${perf.tradingPnlQuote >= 0 ? "+" : ""}${fmt(perf.tradingPnlQuote)} ${QUOTE_SYMBOL}`}
                </dd>
                <dt className="text-[var(--color-ink-soft)]">First trade</dt>
                <dd>{perf.firstTradeAt ? new Date(perf.firstTradeAt * 1000).toLocaleDateString() : "—"}</dd>
              </dl>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
              <strong>Not a total return.</strong> This is the net effect of
              executed trades only, valued at the current price. It excludes
              deposits and withdrawals entirely. A total return needs a cost
              basis, the vault records none, and estimating one would put a
              guess next to measured numbers.
            </p>
          </Panel>

          <Panel title="Risk envelope" index="04" note="Enforced on chain at execution.">
            {limits ? (
              <dl className="tabular grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
                <dt className="text-[var(--color-ink-soft)]">Trade size</dt>
                <dd>{limits.sizeBps / 100}%</dd>
                <dt className="text-[var(--color-ink-soft)]">Max per trade</dt>
                <dd>{limits.maxTradeBps / 100}%</dd>
                <dt className="text-[var(--color-ink-soft)]">Max slippage</dt>
                <dd>{limits.maxSlippageBps / 100}%</dd>
                <dt className="text-[var(--color-ink-soft)]">Cooldown</dt>
                <dd>{limits.cooldownSeconds}s</dd>
                <dt className="text-[var(--color-ink-soft)]">Minimum trade</dt>
                <dd>
                  {exposure === null || exposure.minTradeBps === 0
                    ? "none set"
                    : `${exposure.minTradeBps / 100}% of balance`}
                </dd>
              </dl>
            ) : (
              <p className="text-[12px] text-[var(--color-ink-soft)]">Reading limits…</p>
            )}
          </Panel>
        </div>

        <div className="mt-5">
          <Panel title="Recent transactions" index="05" note="From the chain, including anything an executor did.">
            {activity === null ? (
              <p className="text-[12px] text-[var(--color-ink-soft)]">Loading…</p>
            ) : activity.length === 0 ? (
              <p className="text-[12px] text-[var(--color-ink-soft)]">
                No transactions yet.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-rule)]">
                {activity.map((a) => (
                  <li key={a.signature} className="flex items-baseline justify-between gap-3 py-2 text-[12px]">
                    <span>
                      {a.summary}
                      {a.failed ? <span className="ml-2 text-[var(--color-exposed)]">failed</span> : null}
                    </span>
                    <a
                      className="tabular text-[11px] text-[var(--color-ink-soft)] underline-offset-2 hover:underline"
                      href={`https://explorer.solana.com/tx/${a.signature}?cluster=devnet`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {a.at ? new Date(a.at * 1000).toLocaleString() : "pending"}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="mt-5">
          <Panel title="Where each number comes from" index="06">
            <dl className="space-y-2 text-[12px] leading-relaxed">
              <div>
                <dt className="font-medium">On chain</dt>
                <dd className="text-[var(--color-ink-soft)]">
                  Token balances, risk limits, every transaction, and every
                  trade&rsquo;s inputs and outputs. Facts, verifiable by anyone.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Oracle-derived</dt>
                <dd className="text-[var(--color-ink-soft)]">
                  Anything expressed in {QUOTE_SYMBOL} that involves{" "}
                  {BASE_SYMBOL}. Correct only as of the price shown, from the
                  same feed the program reads.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Calculated here</dt>
                <dd className="text-[var(--color-ink-soft)]">
                  Percentages, allocation, and trading P&L — arithmetic over the
                  two rows above, done in this browser.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Not available</dt>
                <dd className="text-[var(--color-ink-soft)]">
                  Total return, unrealised gain, and cost basis. The protocol
                  does not record what a deposit was worth, so these cannot be
                  computed — only guessed, which is why they are absent.
                </dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>
    </main>
  );
}
