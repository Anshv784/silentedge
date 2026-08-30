"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useVault } from "@/lib/use-vault";
import { useProgram, readExposureLimits, readLimits } from "@/lib/vault-program";
import { readActivity, readOraclePrice, type Activity } from "@/lib/activity";
import { readPerformance, type VaultPerformance } from "@/lib/marketplace";
import { QUOTE_SYMBOL, BASE_SYMBOL } from "@silentedge/config";
import {
  Alert,
  Block,
  BlockHead,
  PageHead,
  Prov,
  Reveal,
  Row,
  Skeleton,
  Ticking,
} from "@/components/ui";

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
 *
 * The layout says the same thing the copy does. Everything on this page is
 * `exposed` — a stranger with the vault address can read all of it on chain —
 * so every data block carries the public provenance rail and they align down
 * the page into one column of data class. Nothing here is shielded, so nothing
 * here is dressed as shielded. With no wallet connected the total is not
 * private either; it is simply unknown to a page with no address to read, and
 * it renders as `.unknown` rather than as the redaction hatch.
 *
 * The two places that name what cannot be computed — "Not a total return" and
 * the "Not available" row of the provenance legend — are set at 20px beside
 * the numbers they qualify. They used to be the smallest type on the screen.
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
    <>
      <PageHead
        title="Portfolio"
        subtitle="What you hold, and where each number comes from"
      />

      {publicKey && !v.vaultAddress ? (
        <div className="mb-6">
          <Alert tone="warn" title="No vault yet.">
            You have not created a vault. Your wallet balances are still shown
            below; nothing is being traded.
          </Alert>
        </div>
      ) : null}

      <Reveal as="div">
        <div className="ledger lg:grid-cols-2">
          {/* ------------------------------------------------- the one figure
              The only text-figure on the screen. `money` because a person acts
              on this number: a spring that overshoots would show a balance
              that was never true. */}
          <Block prov="public" className="lg:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="u-label text-[var(--color-ink-faint)]">
                Total value
              </div>
              <Prov tone="public">Exposed · on chain</Prov>
            </div>

            <div className="tabular mt-4 flex items-baseline gap-3 text-figure">
              {!publicKey ? (
                <>
                  {/* Not redacted — unknown. A vault balance is public data;
                      this page just has no address to read it at. */}
                  <span className="unknown" aria-hidden>
                    0,000.00
                  </span>
                  <span className="sr-only">
                    Unknown — no wallet is connected
                  </span>
                </>
              ) : v.loading ? (
                <Skeleton w="9ch" />
              ) : total === null ? (
                <span className="text-[var(--color-ink-faint)]">
                  unavailable
                </span>
              ) : (
                <Ticking value={total} format={(n) => fmt(n)} kind="money" />
              )}
              <span className="text-title text-[var(--color-ink-soft)]">
                {QUOTE_SYMBOL}
              </span>
            </div>

            {!publicKey ? (
              <p className="mt-4 text-caption text-[var(--color-ink-soft)]">
                Connect a wallet to see your holdings.
              </p>
            ) : null}

            <div className="mt-7 grid gap-x-10 sm:grid-cols-2">
              <Row
                label="In the vault"
                value={`${fmt(vaultValue)} ${QUOTE_SYMBOL}`}
              />
              <Row
                label="In your wallet"
                value={`${fmt(walletValue)} ${QUOTE_SYMBOL}`}
              />
              <Row
                label="Price used"
                value={
                  price === null ? (
                    "—"
                  ) : (
                    <Ticking
                      value={price}
                      format={(n) => `$${n.toFixed(2)}`}
                      kind="feed"
                    />
                  )
                }
              />
            </div>

            <p className="mt-6 max-w-[68ch] text-caption text-[var(--color-ink-soft)]">
              Only the vault is traded. Wallet balances are shown because they
              are yours, not because anything acts on them.
            </p>
            <p className="mt-2 max-w-[68ch] text-caption text-[var(--color-ink-soft)]">
              Balances are on-chain; the conversion is oracle-derived.
            </p>
          </Block>

          {/* ---------------------------------------------------- allocation */}
          <Block prov="public">
            <BlockHead
              title="Allocation"
              hint="On-chain balances, valued at the oracle price."
            />
            <Row label={QUOTE_SYMBOL} value={fmt(v.vaultUsdc)} />
            <Row label={BASE_SYMBOL} value={fmt(v.vaultWrappedSol, 4)} />
            <Row
              label={`In ${BASE_SYMBOL}`}
              value={
                basePct === null ? "—" : `${basePct.toFixed(1)}% of the vault`
              }
            />
            <Row
              label="Exposure ceiling"
              value={
                exposure === null
                  ? "—"
                  : exposure.maxBaseExposureBps === 0
                    ? "none set"
                    : `${exposure.maxBaseExposureBps / 100}%`
              }
            />

            {exposure && exposure.maxBaseExposureBps > 0 && basePct !== null ? (
              <div className="mt-6">
                <div className="h-1.5 w-full bg-[var(--color-rule)]">
                  <div
                    className="h-1.5 bg-[var(--color-signal)]"
                    style={{
                      width: `${Math.min(100, (basePct / (exposure.maxBaseExposureBps / 100)) * 100).toFixed(1)}%`,
                    }}
                  />
                </div>
                <p className="mt-3 text-caption text-[var(--color-ink-soft)]">
                  New entries are refused once this fills. Exits are never
                  blocked by it.
                </p>
              </div>
            ) : null}
          </Block>

          {/* -------------------------------------------------- risk envelope */}
          <Block prov="public">
            <BlockHead
              title="Risk envelope"
              hint="Enforced on chain at execution."
            />
            {limits ? (
              <>
                <Row label="Trade size" value={`${limits.sizeBps / 100}%`} />
                <Row
                  label="Max per trade"
                  value={`${limits.maxTradeBps / 100}%`}
                />
                <Row
                  label="Max slippage"
                  value={`${limits.maxSlippageBps / 100}%`}
                />
                <Row label="Cooldown" value={`${limits.cooldownSeconds}s`} />
                <Row
                  label="Minimum trade"
                  value={
                    exposure === null || exposure.minTradeBps === 0
                      ? "none set"
                      : `${exposure.minTradeBps / 100}% of balance`
                  }
                />
              </>
            ) : (
              <p className="text-caption text-[var(--color-ink-soft)]">
                Reading limits…
              </p>
            )}
          </Block>

          {/* -------------------------------------------- trading performance
              Full width so the concession can sit beside the numbers it
              qualifies at the same reading size, rather than under them at
              11px. That sentence is the point of this page. */}
          <Block prov="public" className="lg:col-span-2">
            <BlockHead
              title="Trading performance"
              hint="Summed from the program's own trade events. Exact."
            />
            <div className="grid gap-x-14 gap-y-8 lg:grid-cols-2">
              <div>
                {perf === null ? (
                  <p className="text-caption text-[var(--color-ink-soft)]">
                    Reading trade history…
                  </p>
                ) : perf.trades === 0 ? (
                  <p className="max-w-[52ch] text-lead text-[var(--color-ink-soft)]">
                    No trades yet. Nothing to measure — this is an empty
                    history, not a zero return.
                  </p>
                ) : (
                  <>
                    <Row
                      label="Trades"
                      value={`${perf.trades} (${perf.buys} buy / ${perf.sells} sell)`}
                    />
                    <Row
                      label={`Net ${QUOTE_SYMBOL} from trading`}
                      value={`${perf.netQuote >= 0 ? "+" : ""}${fmt(perf.netQuote)}`}
                    />
                    <Row
                      label={`Net ${BASE_SYMBOL} from trading`}
                      value={`${perf.netBase >= 0 ? "+" : ""}${fmt(perf.netBase, 4)}`}
                    />
                    <Row
                      label="Trading P&L"
                      value={
                        <span
                          className={
                            perf.tradingPnlQuote == null
                              ? ""
                              : perf.tradingPnlQuote >= 0
                                ? "text-[var(--color-pos)]"
                                : "text-[var(--color-neg)]"
                          }
                        >
                          {perf.tradingPnlQuote == null
                            ? "—"
                            : `${perf.tradingPnlQuote >= 0 ? "+" : ""}${fmt(perf.tradingPnlQuote)} ${QUOTE_SYMBOL}`}
                        </span>
                      }
                    />
                    <Row
                      label="First trade"
                      value={
                        perf.firstTradeAt
                          ? new Date(
                              perf.firstTradeAt * 1000
                            ).toLocaleDateString()
                          : "—"
                      }
                    />
                  </>
                )}
              </div>

              <p className="max-w-[52ch] text-lead text-[var(--color-ink-soft)]">
                <strong className="font-medium text-[var(--color-ink)]">
                  Not a total return.
                </strong>{" "}
                This is the net effect of executed trades only, valued at the
                current price. It excludes deposits and withdrawals entirely. A
                total return needs a cost basis, the vault records none, and
                estimating one would put a guess next to measured numbers.
              </p>
            </div>
          </Block>

          {/* ----------------------------------------------- recent activity */}
          <Block prov="public" className="lg:col-span-2">
            <BlockHead
              title="Recent transactions"
              hint="From the chain, including anything an executor did."
              right={<Prov tone="public">Exposed · on chain</Prov>}
            />
            {activity === null ? (
              <p className="text-caption text-[var(--color-ink-soft)]">
                Loading…
              </p>
            ) : activity.length === 0 ? (
              <p className="text-caption text-[var(--color-ink-soft)]">
                No transactions yet.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-rule)]">
                {activity.map((a) => (
                  <li
                    key={a.signature}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 text-caption"
                  >
                    <span>
                      {a.summary}
                      {a.failed ? (
                        <span className="ml-2 text-[var(--color-neg)]">
                          failed
                        </span>
                      ) : null}
                    </span>
                    <a
                      className="tabular text-caption text-[var(--color-ink-soft)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
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
          </Block>

          {/* ------------------------------------------------ the provenance
              legend. No rail on this block: it describes data classes, it is
              not itself a reading of the chain. */}
          <Block className="lg:col-span-2">
            <BlockHead title="Where each number comes from" />
            <dl className="divide-y divide-[var(--color-rule)]">
              {SOURCES.map((s) => (
                <div
                  key={s.t}
                  className="grid gap-2 py-5 first:pt-0 last:pb-0 sm:grid-cols-[18ch_1fr] sm:gap-6"
                >
                  <dt className="u-label text-[var(--color-ink-faint)]">
                    {s.t}
                  </dt>
                  <dd
                    className={`max-w-[62ch] text-[var(--color-ink-soft)] ${
                      s.absent ? "text-lead" : "text-body"
                    }`}
                  >
                    {s.d}
                  </dd>
                </div>
              ))}
            </dl>
          </Block>
        </div>
      </Reveal>
    </>
  );
}

/* The four provenance classes, verbatim. The last one is the reason this page
   has no headline return figure, so it is set one step larger than the three
   above it — it is a statement about the product, not a footnote to it. */
const SOURCES: { t: string; d: ReactNode; absent?: boolean }[] = [
  {
    t: "On chain",
    d: (
      <>
        Token balances, risk limits, every transaction, and every trade&rsquo;s
        inputs and outputs. Facts, verifiable by anyone.
      </>
    ),
  },
  {
    t: "Oracle-derived",
    d: (
      <>
        Anything expressed in {QUOTE_SYMBOL} that involves {BASE_SYMBOL}.
        Correct only as of the price shown, from the same feed the program
        reads.
      </>
    ),
  },
  {
    t: "Calculated here",
    d: (
      <>
        Percentages, allocation, and trading P&amp;L — arithmetic over the two
        rows above, done in this browser.
      </>
    ),
  },
  {
    t: "Not available",
    absent: true,
    d: (
      <>
        Total return, unrealised gain, and cost basis. The protocol does not
        record what a deposit was worth, so these cannot be computed — only
        guessed, which is why they are absent.
      </>
    ),
  },
];
