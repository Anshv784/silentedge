"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BASE_SYMBOL, QUOTE_SYMBOL } from "@silentedge/config";
import { describeRule } from "@silentedge/types";
import { WalletButton } from "@/components/shell";
import {
  Alert,
  Badge,
  BlockHead,
  Mono,
  Prov,
  REVEAL_ITEM,
  Reveal,
  Row,
  Skeleton,
  Ticking,
} from "@/components/ui";
import { OhlcLegend, Terminal, type Hover } from "@/components/terminal";
import { CreateVault, Transfer } from "@/components/vault-actions";
import { Receipts } from "@/components/receipts";
import { useVaultStore } from "@/lib/vault-store";
import {
  TIMEFRAMES,
  TRADABLE,
  fetchCandles,
  price as fmtPrice,
  summarize,
  type Candle,
} from "@/lib/market";

const EXPLORER = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";

/** From `programs/vault/src/constants.rs` — INTENT_TTL_SLOTS. */
const INTENT_TTL_SLOTS = 180;

const money = (n: number, dp = 2) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });

/**
 * The overview.
 *
 * Everything the vault is doing, in one screen, read from the chain rather than
 * remembered by this session. The one thing that is *not* here is the strategy
 * itself: it is encrypted to the MPC cluster and no page can read it back, so
 * what is shown is its state (armed or not) and — only while this tab still
 * holds the draft in memory — the rules you typed.
 *
 * Two compositional decisions.
 *
 * **There is no wallet gate.** Disconnected, this page used to be a dashed
 * rectangle inside 280px of chrome: 97% furniture, and the first thing anyone
 * saw after the landing page's primary call to action. Now the whole dashboard
 * renders — live chart, live tape, the full ruled structure — and only the
 * figures this page has no address to read are withheld. Those get the
 * `.unknown` treatment, *not* the shielded hatch: a vault balance is public
 * data that we simply cannot look up without an address, and dressing it as
 * encrypted would be a lie told in CSS.
 *
 * **The authorization band is the loudest object on the screen, and only when
 * it exists.** It used to be the fifth card down. It has a real deadline
 * measured in slots.
 */
export default function Overview() {
  const s = useVaultStore();
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [hover, setHover] = useState<Hover>(null);

  useEffect(() => {
    let alive = true;
    // 1H candles over the last week: the same feed the terminal draws, at the
    // resolution that reads as a week rather than as noise.
    const load = () =>
      fetchCandles(TRADABLE.id, TIMEFRAMES[4], 168)
        .then((c) => alive && setCandles(c))
        .catch(() => alive && setCandles([]));
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const stats = useMemo(() => (candles ? summarize(candles) : null), [candles]);

  const armed = s.mxeVersion > 0;
  const oracleAge = s.oracle
    ? Math.max(0, Math.round(Date.now() / 1000 - s.oracle.publishedAt))
    : null;

  /* The on-chain oracle account is only readable through the program, so it is
     null with no wallet. The relayed candle close is the same publisher and is
     already on screen — showing it beats a skeleton that never resolves, as
     long as the label says which one is being shown. */
  const displayPrice =
    s.oracle?.price ??
    (candles && candles.length ? candles[candles.length - 1].c : null);

  const solValue =
    s.vaultWrappedSol !== null && s.oracle
      ? s.vaultWrappedSol * s.oracle.price
      : null;
  const allocation =
    s.totalValue && s.totalValue > 0 && solValue !== null
      ? Math.min(100, Math.max(0, (solValue / s.totalValue) * 100))
      : 0;

  /* Threshold lines are drawable only from the in-memory draft. Once this tab
     reloads there is no readable copy anywhere, which is the point. */
  const marks = useMemo(() => {
    const d = s.draft;
    if (!d) return [];
    const at = (kind: string) =>
      Number(d.rules.find((r) => r.kind === kind)?.value ?? 0);
    return [
      { price: at("exit"), color: "var(--color-pos)", title: "sell" },
      { price: at("entry"), color: "var(--color-signal-hi)", title: "buy" },
      { price: at("stop"), color: "var(--color-neg)", title: "stop" },
    ].filter((b) => b.price > 0);
  }, [s.draft]);

  /* Slots, not seconds. The program compares against a slot number, and slot
     duration drifts around its 400ms target — rendering a confident "1:12"
     would be inventing precision the chain does not have. */
  const slotsLeft =
    s.pending && s.slot !== null
      ? Math.max(0, Number(s.pending.expiresAtSlot) - s.slot)
      : null;
  const urgent = slotsLeft !== null && slotsLeft < 40;

  return (
    <div className="-mx-4 -mt-8 sm:-mx-6 lg:-mx-10">
      {/* ------------------------------------------- the authorization band */}
      <AnimatePresence>
        {s.pending ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="sticky top-16 z-20 overflow-hidden"
          >
            <div className="accent-surface lit relative">
              <div className="flex flex-wrap items-end justify-between gap-6 px-6 py-6 sm:px-10">
                <div className="min-w-0">
                  <div className="u-label text-[var(--color-signal-hi)]">
                    Authorization live · signed by the cluster
                  </div>
                  <p className="mt-3 text-lead">
                    A{" "}
                    <strong className="font-medium">
                      {s.pending.side === 1 ? "buy" : "sell"} of{" "}
                      {s.pending.side === 1
                        ? `${money(Number(s.pending.amountIn) / 1e6)} ${QUOTE_SYMBOL}`
                        : `${money(Number(s.pending.amountIn) / 1e9, 4)} ${BASE_SYMBOL}`}
                    </strong>
                    .
                  </p>
                  <p className="mt-2 max-w-[64ch] text-caption text-[var(--color-ink-soft)]">
                    Side, size, price floor and expiry were fixed by the
                    computation — executing only chooses the moment. Anyone can
                    submit it, so you never have to wait for us.
                  </p>
                </div>

                <div className="flex flex-wrap items-end gap-8">
                  <div>
                    <div
                      className="u-label"
                      style={{
                        color: urgent
                          ? "var(--color-neg)"
                          : "var(--color-exposed)",
                      }}
                    >
                      Slots until this expires
                    </div>
                    <div
                      className="tabular mt-2 text-figure"
                      style={{
                        color: urgent
                          ? "var(--color-neg)"
                          : "var(--color-ink)",
                      }}
                    >
                      {slotsLeft ?? "—"}
                    </div>
                    <div className="mt-2 text-caption text-[var(--color-ink-soft)]">
                      ≈ {slotsLeft === null ? "—" : Math.round(slotsLeft * 0.4)}
                      &nbsp;s at 400&nbsp;ms per slot · the program checks the
                      slot, not a clock
                    </div>
                  </div>
                  <button
                    className="btn btn-xl btn-primary"
                    onClick={s.executeNow}
                    disabled={s.busy.executing}
                  >
                    {s.busy.executing ? "Executing…" : "Execute it myself"}
                  </button>
                </div>
              </div>

              {/* The drain. `linear`, always — it is measuring a real quantity
                  and any easing would be a lie about the clock. */}
              <div className="h-[2px] w-full bg-[color-mix(in_srgb,var(--color-signal)_25%,transparent)]">
                <motion.div
                  className="h-full origin-left"
                  style={{ background: urgent ? "var(--color-neg)" : "var(--color-signal)" }}
                  animate={{
                    scaleX:
                      slotsLeft === null
                        ? 1
                        : Math.min(1, slotsLeft / INTENT_TTL_SLOTS),
                  }}
                  transition={{ duration: 0.4, ease: "linear" }}
                />
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* -------------------------------------------------------- masthead */}
      <div className="border-b border-[var(--color-rule)] px-4 pb-9 pt-9 sm:px-6 lg:px-10">
        <div className="grid gap-9 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="prov prov-public">
            <div className="u-label">
              {s.connected && s.vaultAddress
                ? `Vault · ${s.vaultAddress.toString().slice(0, 4)}…${s.vaultAddress
                    .toString()
                    .slice(-4)}`
                : "Vault value"}
            </div>

            {s.connected ? (
              <div className="tabular mt-4 text-figure">
                {s.totalValue === null ? (
                  <span className="text-[var(--color-ink-faint)]">—</span>
                ) : (
                  <>
                    <span className="text-[0.32em] align-super text-[var(--color-ink-soft)]">
                      $
                    </span>
                    <Ticking value={s.totalValue} format={(n) => money(n)} />
                  </>
                )}
              </div>
            ) : (
              <>
                {/* Not the shielded hatch. This number is public; this page
                    just has no address to look it up with. */}
                <div
                  className="unknown tabular mt-4 inline-block text-figure"
                  aria-label="Not available without a connected wallet"
                >
                  0,000.00
                </div>
                <div className="u-label mt-4">
                  Connect a wallet to read this vault
                </div>
              </>
            )}

            {s.connected ? (
              <p className="mt-4 text-caption text-[var(--color-ink-soft)]">
                {s.oracle
                  ? `at the Pyth price the program reads · ${oracleAge}s old`
                  : "oracle unavailable"}
              </p>
            ) : null}
          </div>

          <div className="ledger sm:grid-cols-2 lg:min-w-[380px]">
            <div className="block">
              <div className="u-label">
                {BASE_SYMBOL} / USD
              </div>
              <div className="tabular mt-3 text-title">
                {displayPrice === null ? (
                  <Skeleton w="7ch" />
                ) : (
                  <>
                    $
                    <Ticking value={displayPrice} kind="feed" format={fmtPrice} />
                  </>
                )}
              </div>
              <div className="u-label mt-2">
                {s.oracle ? "on-chain oracle account" : "display feed"}
              </div>
              <div
                className="mt-2 text-caption"
                style={{
                  color: stats
                    ? stats.changePct >= 0
                      ? "var(--color-pos)"
                      : "var(--color-neg)"
                    : undefined,
                }}
              >
                {stats
                  ? `${stats.changePct >= 0 ? "+" : ""}${stats.changePct.toFixed(2)}% over 7d`
                  : "loading history"}
              </div>
            </div>
            <div className="block">
              <div className="u-label">Strategy</div>
              <div className="mt-3 text-title capitalize">
                {!s.connected
                  ? "—"
                  : armed
                    ? "Armed"
                    : s.submitted
                      ? "Saved"
                      : "None"}
              </div>
              <div className="mt-2 text-caption text-[var(--color-ink-soft)]">
                {armed
                  ? `encrypted to the cluster · v${s.mxeVersion}`
                  : s.connected
                    ? "the cluster holds nothing it can evaluate"
                    : "vault status unknown"}
              </div>
            </div>
          </div>
        </div>

        {/* The action row. Deposit and withdraw were buried inside a card in
            the narrow column, which said "supporting detail" about the two
            things the page is actually for. */}
        {s.connected && s.vaultStatus ? (
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/app/strategy" className="btn btn-lg btn-primary">
              {s.draft || armed ? "Open the studio" : "Build a strategy"}
            </Link>
            <Link href="/app/market" className="btn btn-lg btn-ghost">
              Open the terminal
            </Link>
            <Link href="/app/vault" className="btn btn-lg btn-ghost">
              Risk limits
            </Link>
            <span className="ml-auto">
              <Prov tone="public">Exposed · readable on chain</Prov>
            </span>
          </div>
        ) : null}
      </div>

      <div className="px-4 pb-32 pt-8 sm:px-6 lg:px-10">
        <AnimatePresence>
          {s.error ? (
            <Alert tone="bad" title="Could not read the chain.">
              {s.error}{" "}
              <button onClick={s.refresh} className="underline underline-offset-2">
                Retry
              </button>
            </Alert>
          ) : null}
          {s.actionError ? (
            <Alert tone="bad" title="Last action failed.">
              {s.actionError}{" "}
              <button
                onClick={s.clearError}
                className="underline underline-offset-2"
              >
                Dismiss
              </button>
            </Alert>
          ) : null}
          {s.mxe && !s.mxe.live ? (
            <Alert tone="warn" title="MPC cluster key unavailable.">
              {s.mxe.reason} Strategies cannot be armed safely until this reads
              live — submitting now would encrypt to a public development key.
            </Alert>
          ) : null}
        </AnimatePresence>

        <Reveal className="mt-2">
          <div className="ledger xl:grid-cols-[1.7fr_1fr]">
            {/* ------------------------------------------------ left column */}
            <motion.div variants={REVEAL_ITEM} className="block prov prov-public">
              <BlockHead
                eyebrow="Exposed · public price data"
                title={`${TRADABLE.label} · 7 days of 1H`}
                hint="Display feed relayed by this site from Pyth. The program acts on the on-chain price account, not on these candles."
                right={
                  <Link
                    href="/app/market"
                    className="text-caption text-[var(--color-signal-hi)] underline-offset-2 hover:underline"
                  >
                    Terminal →
                  </Link>
                }
              />
              <OhlcLegend
                hover={hover}
                latest={candles && candles.length ? candles[candles.length - 1] : null}
              />
              {candles === null ? (
                <div className="mt-3 h-[300px] animate-pulse bg-[var(--color-panel)]" />
              ) : (
                <Terminal
                  candles={candles}
                  overlays={[]}
                  studies={[]}
                  marks={marks}
                  height={300}
                  onHover={setHover}
                />
              )}
              {stats ? (
                <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-[var(--color-rule)] pt-5 sm:grid-cols-4">
                  {[
                    ["7d high", `$${fmtPrice(stats.high)}`],
                    ["7d low", `$${fmtPrice(stats.low)}`],
                    ["Volatility", `${stats.volAnnualPct.toFixed(0)}% ann.`],
                    ["Max drawdown", `${stats.maxDrawdownPct.toFixed(1)}%`],
                  ].map(([k, val]) => (
                    <div key={k}>
                      <dt className="u-label">{k}</dt>
                      <dd className="tabular mt-2 text-[17px]">{val}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {marks.length > 0 ? (
                <p className="mt-5 text-caption text-[var(--color-ink-soft)]">
                  The dashed levels are your draft, held in this tab&rsquo;s
                  memory. They are not read back from the chain — the stored
                  copy is encrypted and nobody, including this page, can decrypt
                  it.
                </p>
              ) : null}
            </motion.div>

            {/* ----------------------------------------------- right column */}
            <motion.div variants={REVEAL_ITEM} className="block prov prov-private">
              <BlockHead
                eyebrow="Shielded · never leaves the computation"
                title="Strategy"
                right={
                  armed ? (
                    <Badge tone="shielded" dot>
                      Armed
                    </Badge>
                  ) : s.submitted ? (
                    <Badge tone="warn">Not armed</Badge>
                  ) : (
                    <Badge>Empty</Badge>
                  )
                }
              />
              {s.draft ? (
                <>
                  <p className="mb-4 text-[17px] font-medium">{s.draft.name}</p>
                  <ul className="tabular space-y-2 text-[15px] text-[var(--color-ink-soft)]">
                    {s.draft.rules.map((r) => (
                      <li key={r.kind}>{describeRule(r)}</li>
                    ))}
                  </ul>
                  <p className="mt-4 text-caption text-[var(--color-ink-faint)]">
                    {s.draft.sizeBps / 100}% of the vault per trade
                  </p>
                </>
              ) : armed ? (
                <p className="text-caption text-[var(--color-ink-soft)]">
                  A strategy is armed and the cluster can evaluate it. Its
                  thresholds are not shown because they cannot be read back —
                  the only stored copy is encrypted to the cluster.
                </p>
              ) : (
                <div className="space-y-3">
                  {["Buy below", "Sell above", "Stop below", "Size"].map((l) => (
                    <div
                      key={l}
                      className="flex items-baseline justify-between gap-3 border-b border-[var(--color-rule)] pb-3"
                    >
                      <span className="text-caption text-[var(--color-ink-soft)]">
                        {l}
                      </span>
                      <span
                        className="redacted tabular px-3 text-lead"
                        aria-label="Not set"
                      >
                        000.00
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <Link href="/app/strategy" className="btn btn-lg btn-primary mt-6 w-full">
                {s.draft || armed ? "Open the studio" : "Build a strategy"}
              </Link>
            </motion.div>

            {/* --------------------------------------------------- balances */}
            {s.connected && !s.vaultStatus ? (
              <motion.div variants={REVEAL_ITEM} className="block xl:col-span-2">
                <BlockHead
                  title="No vault yet"
                  hint="A program-derived account only your address can withdraw from."
                />
                <CreateVault owner={s.owner!} onDone={s.record} />
              </motion.div>
            ) : null}

            {s.connected && s.vaultStatus ? (
              <motion.div variants={REVEAL_ITEM} className="block prov prov-public">
                <BlockHead
                  eyebrow="Exposed · readable on chain"
                  title="Balances & transfer"
                />
                <div className="mb-3 h-1.5 overflow-hidden bg-[var(--color-panel)]">
                  <div
                    className="h-full bg-[var(--color-signal)] transition-[width] duration-500"
                    style={{ width: `${allocation}%` }}
                    aria-hidden
                  />
                </div>
                <p className="mb-5 text-caption text-[var(--color-ink-faint)]">
                  {allocation.toFixed(0)}% of vault value in {BASE_SYMBOL},{" "}
                  {(100 - allocation).toFixed(0)}% in {QUOTE_SYMBOL}
                </p>
                <div className="border-t border-[var(--color-rule)]">
                  <Row
                    label={`Vault ${QUOTE_SYMBOL}`}
                    value={s.vaultUsdc === null ? "—" : money(s.vaultUsdc)}
                  />
                  <Row
                    label={`Vault ${BASE_SYMBOL}`}
                    value={
                      s.vaultWrappedSol === null ? "—" : money(s.vaultWrappedSol, 4)
                    }
                  />
                  <Row
                    label={`Wallet ${QUOTE_SYMBOL}`}
                    value={s.walletUsdc === null ? "—" : money(s.walletUsdc)}
                  />
                  <Row
                    label={`Wallet ${BASE_SYMBOL}`}
                    value={s.walletSol === null ? "—" : money(s.walletSol, 4)}
                  />
                </div>
                <p className="mt-4 text-caption text-[var(--color-ink-faint)]">
                  Profit and loss is not shown: the vault records no cost basis,
                  so it cannot be computed from chain state, and estimating one
                  would be a guess presented as a number.
                </p>
                <div className="mt-6 space-y-6 border-t border-[var(--color-rule)] pt-6">
                  <Transfer
                    owner={s.owner!}
                    direction="deposit"
                    available={{
                      [QUOTE_SYMBOL]: s.walletUsdc ?? 0,
                      [BASE_SYMBOL]: s.walletSol ?? 0,
                    }}
                    onDone={s.record}
                  />
                  <Transfer
                    owner={s.owner!}
                    direction="withdraw"
                    available={{
                      [QUOTE_SYMBOL]: s.vaultUsdc ?? 0,
                      [BASE_SYMBOL]: s.vaultWrappedSol ?? 0,
                    }}
                    onDone={s.record}
                  />
                </div>
              </motion.div>
            ) : null}

            {/* --------------------------------------------------- activity */}
            <motion.div variants={REVEAL_ITEM} className="block xl:col-span-2">
              <BlockHead
                eyebrow="Exposed · readable on chain"
                title="Vault activity"
                hint="Read from the chain, including anything an executor did on your behalf."
                right={
                  s.connected && s.limits ? (
                    <Link
                      href="/app/vault"
                      className="text-caption text-[var(--color-ink-soft)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
                    >
                      Limits: {s.limits.sizeBps / 100}% per trade ·{" "}
                      {s.limits.maxSlippageBps / 100}% slippage ·{" "}
                      {s.limits.cooldownSeconds}s cooldown →
                    </Link>
                  ) : null
                }
              />
              {!s.connected ? (
                <p className="text-caption text-[var(--color-ink-soft)]">
                  Activity is read from the chain against a specific vault
                  address, so there is nothing to show until a wallet is
                  connected.
                </p>
              ) : s.activity === null ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} />
                  ))}
                </div>
              ) : s.activity.length === 0 ? (
                <p className="text-caption text-[var(--color-ink-soft)]">
                  Deposits, strategy changes and trades all appear here once the
                  vault is used.
                </p>
              ) : (
                <ul>
                  {s.activity.slice(0, 12).map((a) => (
                    <li
                      key={a.signature}
                      className="flex items-center justify-between gap-3 border-b border-[var(--color-rule)] py-3 last:border-0"
                    >
                      <span className="flex items-center gap-2.5 text-[15px]">
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 shrink-0"
                          style={{
                            background: a.failed
                              ? "var(--color-neg)"
                              : "var(--color-pos)",
                          }}
                        />
                        {a.summary}
                        {a.failed ? (
                          <span className="text-caption text-[var(--color-neg)]">
                            failed
                          </span>
                        ) : null}
                      </span>
                      <a
                        className="tabular shrink-0 text-caption text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink-soft)] hover:underline"
                        href={`https://explorer.solana.com/tx/${a.signature}?cluster=${EXPLORER}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {a.at ? new Date(a.at * 1000).toLocaleString() : "pending"}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </motion.div>
          </div>
        </Reveal>

        {s.connected ? <Receipts items={s.receipts} /> : null}

        {/* Addresses, demoted to a footer strip. */}
        {s.connected && s.vaultAddress ? (
          <div className="mt-8 flex flex-wrap items-center gap-x-10 gap-y-3 border-t border-[var(--color-rule)] pt-5">
            <span className="u-label">Addresses</span>
            <span className="flex items-center gap-2">
              <span className="u-label">Wallet</span>
              <Mono copy>{s.owner?.toString()}</Mono>
            </span>
            <span className="flex items-center gap-2">
              <span className="u-label">
                Vault (derived)
              </span>
              <Mono copy>{s.vaultAddress?.toString()}</Mono>
            </span>
          </div>
        ) : null}
      </div>

      {/* The connect prompt, as a bar rather than as a gate that replaced the
          entire page with an outline of a box. */}
      {!s.connected ? (
        <div className="sticky bottom-0 z-30 border-t border-[var(--color-rule)] bg-[color-mix(in_srgb,var(--color-paper)_92%,transparent)] backdrop-blur-md">
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-10">
            <p className="max-w-[60ch] text-caption text-[var(--color-ink-soft)]">
              Connecting only reads public balances. Nothing is signed and no
              funds move until you ask.
            </p>
            <WalletButton />
          </div>
        </div>
      ) : null}
    </div>
  );
}
