"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { BASE_SYMBOL, QUOTE_SYMBOL, VAULT_SEED } from "@silentedge/config";
import { useVault } from "@/lib/use-vault";
import { Address, Figure, Panel, Tag } from "@/components/readouts";
import {
  CreateVault,
  Transfer,
  type Receipt,
} from "@/components/vault-actions";
import { Receipts } from "@/components/receipts";
import { StrategyBuilder } from "@/components/strategy-builder";
import { describeRule, normalize, type Strategy } from "@silentedge/types";
import { deriveEncryptionKeypair, encryptStrategy } from "@silentedge/sdk";
import { fetchMxePublicKey, type MxeKey } from "@/lib/mxe";
import {
  submitStrategy,
  convertStrategy,
  readMxeVersion,
  readPendingIntent,
  selfExecute,
  setStatus,
  readableError,
  useProgram,
} from "@/lib/vault-program";
import { VAULT_PROGRAM_ID } from "@silentedge/config";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  readActivity,
  readOraclePrice,
  vaultValueInQuote,
  type Activity,
} from "@/lib/activity";
import { readLimits, updateLimits } from "@/lib/vault-program";

const PYTH_SOL_USD = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

// The wallet button reads `window` on mount, so it cannot be server-rendered.
const WalletButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-[38px] w-[152px]" /> }
);

export default function Page() {
  const { publicKey, connected, signMessage } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const v = useVault();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [editing, setEditing] = useState(false);
  /**
   * Draft strategies live in memory and nowhere else. Nothing is persisted to
   * localStorage or sent anywhere until the encryption phase, because a draft
   * written to disk in the clear is a strategy leak with extra steps.
   */
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [mxe, setMxe] = useState<MxeKey | null>(null);
  const [encrypting, setEncrypting] = useState(false);
  const [encryptError, setEncryptError] = useState<string | null>(null);
  const [submittedVersion, setSubmittedVersion] = useState<number | null>(null);
  const [converting, setConverting] = useState(false);
  /** 0 until the cluster has re-encrypted the strategy to itself. */
  const [mxeVersion, setMxeVersion] = useState<number>(0);
  const [pending, setPending] = useState<{ side: number; amountIn: bigint } | null>(null);
  const [executing, setExecuting] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [oracle, setOracle] = useState<{ price: number; publishedAt: number } | null>(null);
  const [limits, setLimits] = useState<Awaited<ReturnType<typeof readLimits>>>(null);
  /**
   * The builder's size ceiling is the vault's own `max_trade_bps`, not a
   * constant. It was hardcoded to 1000, so a vault configured with a different
   * cap would have had the builder disagree with the program — either refusing
   * a size the chain would accept, or accepting one it would reject at
   * execution, after an MPC evaluation had already been paid for.
   */
  const sizeCap = limits?.maxTradeBps ?? 1_000;
  const [editingLimits, setEditingLimits] = useState(false);
  const [limitsBusy, setLimitsBusy] = useState(false);

  /**
   * Limits are enforced now, and the vault has no close instruction, so a bad
   * value chosen at creation would otherwise bind that vault forever. Saving
   * bumps the vault nonce, which invalidates any authorization already in
   * flight — an intent carries no copy of the envelope it was issued under.
   */
  async function saveLimits(next: NonNullable<typeof limits>) {
    if (!program || !publicKey) return;
    setLimitsBusy(true);
    setEncryptError(null);
    try {
      const signature = await updateLimits(program, publicKey, next);
      setLimits(next);
      setEditingLimits(false);
      recordAndRefresh({ signature, action: "Update risk limits", at: Date.now() });
    } catch (e) {
      setEncryptError(readableError(e));
    } finally {
      setLimitsBusy(false);
    }
  }

  useEffect(() => {
    if (!connected) return;
    fetchMxePublicKey(connection, VAULT_PROGRAM_ID).then(setMxe);
  }, [connection, connected]);

  useEffect(() => {
    if (!program || !publicKey) return;
    readMxeVersion(program, publicKey).then(setMxeVersion).catch(() => {});
  }, [program, publicKey, submittedVersion]);

  // Vault history, risk limits and the oracle price the program itself reads.
  // All three come from the chain: nothing here is remembered by the app, so a
  // reload shows the same thing and the executor's work is visible too.
  useEffect(() => {
    if (!program || !publicKey || !v.vaultAddress) return;
    let alive = true;
    const load = async () => {
      const [a, l, o] = await Promise.all([
        readActivity(connection, v.vaultAddress!).catch(() => [] as Activity[]),
        readLimits(program, publicKey).catch(() => null),
        readOraclePrice(connection, PYTH_SOL_USD).catch(() => null),
      ]);
      if (!alive) return;
      setActivity(a);
      setLimits(l);
      setOracle(o);
    };
    load();
    const id = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [program, publicKey, connection, v.vaultAddress, receipts.length]);

  // An authorization is only spendable for ~72 seconds, so this polls rather
  // than waiting for a user action that would usually arrive too late.
  useEffect(() => {
    if (!program || !publicKey) return;
    let alive = true;
    const read = () =>
      readPendingIntent(program, publicKey)
        .then((i) => alive && setPending(i))
        .catch(() => {});
    read();
    const id = setInterval(read, 5_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [program, publicKey, receipts.length]);

  /**
   * Pause, resume, or stop. Owner-only, and deliberately unable to trap funds:
   * `withdraw` never reads status, so the worst a status change can do is stop
   * new trading.
   */
  async function changeStatus(action: "pause" | "resume" | "stop") {
    if (!program || !publicKey) return;
    if (action === "stop" &&
        !confirm("Stop is permanent. The vault can never trade again, though you can always withdraw. Continue?")) {
      return;
    }
    setStatusBusy(true);
    setEncryptError(null);
    try {
      const signature = await setStatus(program, publicKey, action);
      recordAndRefresh({ signature, action: `${action[0].toUpperCase()}${action.slice(1)} vault`, at: Date.now() });
    } catch (e) {
      setEncryptError(readableError(e));
    } finally {
      setStatusBusy(false);
    }
  }

  /**
   * Spend the pending authorization from this browser.
   *
   * Present so that nobody has to trust our executor to be running, honest, or
   * fast. `execute_trade` is permissionless and every parameter was fixed by
   * the verified callback, so this is the same transaction the executor would
   * send — just paid for by you.
   */
  async function executeNow() {
    if (!program || !publicKey || !pending) return;
    setExecuting(true);
    setEncryptError(null);
    try {
      const signature = await selfExecute(program, publicKey, pending);
      recordAndRefresh({
        signature,
        action: `Execute authorized ${pending.side === 1 ? "buy" : "sell"}`,
        at: Date.now(),
      });
      setPending(null);
    } catch (e) {
      setEncryptError(readableError(e));
    } finally {
      setExecuting(false);
    }
  }

  /**
   * Conversion finishes in a callback, not in the transaction that queues it,
   * so the only honest signal is the on-chain version moving. Polling for it
   * keeps the UI from claiming "armed" while the cluster is still working.
   */
  async function waitForConversion(p: NonNullable<typeof program>, owner: typeof publicKey) {
    if (!owner) return;
    const before = mxeVersion;
    for (let i = 0; i < 40; i++) {
      const now = await readMxeVersion(p, owner).catch(() => before);
      if (now > before) {
        setMxeVersion(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error("the cluster did not finish converting in time");
  }

  /**
   * Encrypt in the browser, then submit only the ciphertext.
   *
   * The plaintext never leaves this function's scope: it is normalized,
   * encrypted, and the result handed to the transaction builder. No fetch, no
   * storage, no logging of the draft anywhere along the way.
   */
  async function encryptAndSubmit(draft: Strategy) {
    if (!program || !publicKey || !signMessage || !mxe) return;

    // Refuse rather than encrypt to the development stand-in.
    //
    // `fetchMxePublicKey` falls back to a fixed, public, in-repo constant on
    // any error, and this guard used to check only `!mxe`. With a real MXE
    // deployed, that fallback is no longer a visible dev state — it is what a
    // transient RPC failure looks like, and it would have silently published a
    // strategy anyone can decrypt while the UI said "encrypted on chain".
    if (!mxe.live) {
      setEncryptError(
        "Not submitting: the MXE encryption key could not be read, so the " +
          "strategy would be encrypted to a public development key. Retry."
      );
      return;
    }

    setEncrypting(true);
    setEncryptError(null);
    try {
      const keypair = await deriveEncryptionKeypair(signMessage);
      const encrypted = encryptStrategy(
        normalize(draft, sizeCap),
        mxe.key,
        keypair.privateKey
      );
      const signature = await submitStrategy(program, publicKey, encrypted);
      setSubmittedVersion((v) => (v ?? 0) + 1);
      recordAndRefresh({
        signature,
        action: `Encrypt strategy "${draft.name}"`,
        at: Date.now(),
      });

      // Second signature, and the one that actually arms the bot.
      //
      // Submitting stores a strategy only you can read. Converting re-encrypts
      // it to the cluster, which is what lets evaluations run with nobody
      // online. Skipping it leaves a strategy that looks saved and can never
      // fire — `evaluate_strategy` refuses with StrategyNotConverted while
      // mxe_version is 0. Only the owner can do this, so it cannot be deferred
      // to the executor.
      setConverting(true);
      try {
        const convertSig = await convertStrategy(program, publicKey);
        recordAndRefresh({
          signature: convertSig,
          action: "Hand strategy to the MPC cluster",
          at: Date.now(),
        });
        await waitForConversion(program, publicKey);
      } catch (e) {
        setEncryptError(
          `Strategy saved, but not yet armed: ${readableError(e)} ` +
            "It cannot trade until conversion succeeds. Retry from Convert."
        );
      } finally {
        setConverting(false);
      }
    } catch (e) {
      setEncryptError(readableError(e));
    } finally {
      setEncrypting(false);
    }
  }

  // Balances drive the Max control and the over-balance guard, so they have to
  // be re-read after every action rather than left stale.
  function recordAndRefresh(r: Receipt) {
    setReceipts((prev) => [r, ...prev]);
    v.refresh();
  }

  return (
    <main className="grid-field min-h-dvh">
      <div className="mx-auto max-w-5xl px-5 pb-24 pt-8 sm:px-8">
        <header className="mb-12 flex flex-wrap items-start justify-between gap-6 border-b border-[var(--color-rule)] pb-6">
          <div>
            <a
              href="/"
              className="text-[15px] font-medium tracking-[0.04em] underline-offset-4 hover:underline"
            >
              SilentEdge
            </a>
            <p className="mt-1 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
              A vault only you can withdraw from, and a strategy only the
              computation can read.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <a href="/app/market" className="text-[13px] underline-offset-4 hover:underline">
              Market
            </a>
            <a href="/app/backtest" className="text-[13px] underline-offset-4 hover:underline">
              Backtest
            </a>
            <WalletButton />
          </div>
        </header>

        {!connected ? (
          <div className="border border-[var(--color-rule)] bg-[var(--color-panel)] px-6 py-14 text-center">
            <p className="text-[14px]">Connect a wallet to see your vault.</p>
            <p className="mx-auto mt-2 max-w-sm text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
              Connecting only reads public balances. Nothing is signed and no
              funds move until you ask.
            </p>
          </div>
        ) : (
          <>
            {v.error ? (
              <div
                role="alert"
                className="mb-6 border border-[var(--color-rule)] bg-[var(--color-panel)] px-5 py-3 text-[12px]"
              >
                <span className="text-[var(--color-exposed)]">
                  Could not read the chain.
                </span>{" "}
                <span className="text-[var(--color-ink-soft)]">{v.error}</span>{" "}
                <button
                  onClick={v.refresh}
                  className="underline underline-offset-2"
                >
                  Retry
                </button>
              </div>
            ) : null}

            <div className="grid items-start gap-5 lg:grid-cols-2">
              {/* --- Wallet -------------------------------------------- */}
              <Panel
                title="Your wallet"
                index="01"
                note="Held by your wallet software. SilentEdge never sees your keys."
              >
                <div className="mb-4">
                  <Address value={publicKey} label="Address" />
                </div>
                <div className="divide-y divide-[var(--color-rule)] border-t border-[var(--color-rule)]">
                  <Figure
                    label={BASE_SYMBOL}
                    value={v.walletSol}
                    unit={BASE_SYMBOL}
                    loading={v.loading}
                  />
                  <Figure
                    label={QUOTE_SYMBOL}
                    value={v.walletUsdc}
                    unit={QUOTE_SYMBOL}
                    loading={v.loading}
                  />
                </div>
                <div className="mt-4 flex justify-end">
                  <Tag kind="exposed" />
                </div>
              </Panel>

              {/* --- Vault --------------------------------------------- */}
              <Panel
                title="Your vault"
                index="02"
                note={
                  v.vaultStatus
                    ? "Program-controlled. Withdrawals go to your address only — the destination is derived, not chosen."
                    : undefined
                }
              >
                <div className="mb-4">
                  <Address value={v.vaultAddress} label="Address (derived)" />
                  <p className="tabular mt-2 text-[10px] leading-relaxed text-[var(--color-ink-soft)]">
                    seeds = &quot;{VAULT_SEED}&quot; + your address
                  </p>
                </div>

                {v.vaultStatus ? (
                  <>
                    <div className="divide-y divide-[var(--color-rule)] border-t border-[var(--color-rule)]">
                      <Figure
                        label={QUOTE_SYMBOL}
                        value={v.vaultUsdc}
                        unit={QUOTE_SYMBOL}
                        loading={v.loading}
                      />
                      <Figure
                        label={BASE_SYMBOL}
                        value={v.vaultWrappedSol}
                        unit={BASE_SYMBOL}
                        loading={v.loading}
                      />
                      <div className="flex items-baseline justify-between gap-4 py-3">
                        <span className="text-[13px] text-[var(--color-ink-soft)]">
                          Status
                        </span>
                        <span className="tabular text-[13px] capitalize">
                          {v.vaultStatus}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between gap-4 py-3">
                        <span className="text-[13px] text-[var(--color-ink-soft)]">
                          Value
                          <span className="ml-1.5 text-[11px]">
                            (oracle-derived)
                          </span>
                        </span>
                        <span className="tabular text-[13px]">
                          {(() => {
                            const val = vaultValueInQuote(
                              v.vaultUsdc,
                              v.vaultWrappedSol,
                              oracle?.price ?? null
                            );
                            if (v.loading) return "…";
                            if (val === null) return "unavailable";
                            return `${val.toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            })} ${QUOTE_SYMBOL}`;
                          })()}
                        </span>
                      </div>
                      <p className="pb-3 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                        Balances valued at the Pyth price this program reads
                        {oracle
                          ? ` ($${oracle.price.toFixed(2)}, ${Math.max(
                              0,
                              Math.round(Date.now() / 1000 - oracle.publishedAt)
                            )}s old)`
                          : ""}
                        . Profit and loss is not shown: the vault records no cost
                        basis, so it cannot be computed from chain state, and
                        estimating one would be a guess presented as a number.
                      </p>
                      <div className="flex flex-wrap items-center gap-2 py-3">
                        {v.vaultStatus === "active" ? (
                          <button
                            className="border border-[var(--color-rule)] px-3 py-1.5 text-[12px] transition-colors hover:bg-[var(--color-paper)] disabled:opacity-40"
                            onClick={() => changeStatus("pause")}
                            disabled={statusBusy}
                          >
                            Pause trading
                          </button>
                        ) : null}
                        {v.vaultStatus === "paused" ? (
                          <button
                            className="border border-[var(--color-rule)] px-3 py-1.5 text-[12px] transition-colors hover:bg-[var(--color-paper)] disabled:opacity-40"
                            onClick={() => changeStatus("resume")}
                            disabled={statusBusy}
                          >
                            Resume
                          </button>
                        ) : null}
                        {v.vaultStatus !== "stopped" ? (
                          <button
                            className="border border-[var(--color-exposed)] px-3 py-1.5 text-[12px] text-[var(--color-exposed)] transition-opacity hover:opacity-80 disabled:opacity-40"
                            onClick={() => changeStatus("stop")}
                            disabled={statusBusy}
                          >
                            Stop permanently
                          </button>
                        ) : null}
                        <span className="text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                          Withdrawals keep working in every state — pausing can
                          never trap your funds.
                        </span>
                      </div>
                    </div>
                    <div className="mt-4 flex justify-end">
                      <Tag kind="exposed" />
                    </div>

                    <div className="mt-5 space-y-5 border-t border-[var(--color-rule)] pt-5">
                      <Transfer
                        owner={publicKey!}
                        direction="deposit"
                        available={{
                          [QUOTE_SYMBOL]: v.walletUsdc ?? 0,
                          [BASE_SYMBOL]: v.walletSol ?? 0,
                        }}
                        onDone={recordAndRefresh}
                      />
                      <Transfer
                        owner={publicKey!}
                        direction="withdraw"
                        available={{
                          [QUOTE_SYMBOL]: v.vaultUsdc ?? 0,
                          [BASE_SYMBOL]: v.vaultWrappedSol ?? 0,
                        }}
                        onDone={recordAndRefresh}
                      />
                    </div>
                  </>
                ) : (
                  <CreateVault owner={publicKey!} onDone={recordAndRefresh} />
                )}
              </Panel>
            </div>

            {v.vaultAddress ? (
              <Panel title="Risk limits" index="05" note="Enforced on chain, not by this page.">
                {limits ? (
                  <dl className="tabular grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
                    <dt className="text-[var(--color-ink-soft)]">Trade size</dt>
                    <dd>{limits.sizeBps / 100}% of the spendable balance</dd>
                    <dt className="text-[var(--color-ink-soft)]">Max per trade</dt>
                    <dd>{limits.maxTradeBps / 100}% (entries only)</dd>
                    <dt className="text-[var(--color-ink-soft)]">Max slippage</dt>
                    <dd>{limits.maxSlippageBps / 100}%</dd>
                    <dt className="text-[var(--color-ink-soft)]">Cooldown</dt>
                    <dd>{limits.cooldownSeconds}s between entries</dd>
                    <dt className="text-[var(--color-ink-soft)]">Max price age</dt>
                    <dd>{limits.maxOracleStalenessSec}s</dd>
                    <dt className="text-[var(--color-ink-soft)]">Max price uncertainty</dt>
                    <dd>{limits.maxConfBps / 100}%</dd>
                  </dl>
                ) : (
                  <p className="text-[12px] text-[var(--color-ink-soft)]">
                    Reading limits…
                  </p>
                )}
                {limits ? (
                  editingLimits ? (
                    <form
                      className="mt-4 grid grid-cols-2 gap-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget as HTMLFormElement);
                        saveLimits({
                          ...limits,
                          sizeBps: Math.round(Number(f.get("size")) * 100),
                          maxTradeBps: Math.round(Number(f.get("cap")) * 100),
                          maxSlippageBps: Math.round(Number(f.get("slip")) * 100),
                          cooldownSeconds: Math.round(Number(f.get("cool"))),
                        });
                      }}
                    >
                      {[
                        ["size", "Trade size %", limits.sizeBps / 100, 0.01, 100],
                        ["cap", "Max per trade %", limits.maxTradeBps / 100, 0.01, 50],
                        ["slip", "Max slippage %", limits.maxSlippageBps / 100, 0.01, 5],
                        ["cool", "Cooldown (s)", limits.cooldownSeconds, 0, 3600],
                      ].map(([name, label, val, min, max]) => (
                        <label key={String(name)} className="text-[11px]">
                          <span className="text-[var(--color-ink-soft)]">{label}</span>
                          <input
                            name={String(name)}
                            type="number"
                            step="any"
                            min={Number(min)}
                            max={Number(max)}
                            defaultValue={Number(val)}
                            className="tabular mt-1 w-full border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5 text-[12px]"
                          />
                        </label>
                      ))}
                      <div className="col-span-2 flex gap-2">
                        <button
                          type="submit"
                          disabled={limitsBusy}
                          className="border border-[var(--color-signal)] bg-[var(--color-signal)] px-3 py-1.5 text-[12px] text-white disabled:opacity-40"
                        >
                          {limitsBusy ? "Saving…" : "Save limits"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingLimits(false)}
                          className="border border-[var(--color-rule)] px-3 py-1.5 text-[12px]"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="col-span-2 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                        Saving cancels any authorization currently in flight, so
                        a decision made under the old limits cannot execute under
                        the new ones.
                      </p>
                    </form>
                  ) : (
                    <button
                      className="mt-3 border border-[var(--color-rule)] px-3 py-1.5 text-[12px] transition-colors hover:bg-[var(--color-paper)]"
                      onClick={() => setEditingLimits(true)}
                    >
                      Edit limits
                    </button>
                  )
                ) : null}
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                  Exits are exempt from the size cap and the cooldown on purpose:
                  a stop-loss sells the whole position, and a cap can never
                  exceed half of it. Two of the stored limits — a daily loss
                  limit and an execution deviation band — are{" "}
                  <strong>not enforced</strong>; see SECURITY_AUDIT.md rather
                  than reading them as protection.
                </p>
              </Panel>
            ) : null}

            {v.vaultAddress ? (
              <Panel title="Vault activity" index="06" note="Read from the chain, not from this session.">
                {activity === null ? (
                  <p className="text-[12px] text-[var(--color-ink-soft)]">Loading…</p>
                ) : activity.length === 0 ? (
                  <p className="text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
                    Nothing yet. Activity appears here once the vault is used —
                    including anything an executor does on your behalf.
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--color-rule)]">
                    {activity.map((a) => (
                      <li key={a.signature} className="flex items-baseline justify-between gap-3 py-2">
                        <span className="text-[12px]">
                          {a.summary}
                          {a.failed ? (
                            <span className="ml-2 text-[var(--color-exposed)]">failed</span>
                          ) : null}
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
            ) : null}

            <Panel title="What is visible" index="07" note="Being precise about this is the product.">
              <dl className="space-y-2.5 text-[12px] leading-relaxed">
                <div>
                  <dt className="font-medium">Public, on chain</dt>
                  <dd className="text-[var(--color-ink-soft)]">
                    Your vault, its balances, every risk limit including the
                    trade size, every authorization, and every trade. Anyone can
                    read all of it.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Encrypted</dt>
                  <dd className="text-[var(--color-ink-soft)]">
                    Your three price thresholds, and nothing else. No single
                    party can read them — not us, not any one node.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-[var(--color-exposed)]">
                    Leaks over time
                  </dt>
                  <dd className="text-[var(--color-ink-soft)]">
                    Every trade is a public clue about the threshold behind it.
                    Enough trades narrow your rules to a tight range. They are
                    unread, not unknowable.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Never leaves this tab</dt>
                  <dd className="text-[var(--color-ink-soft)]">
                    The draft before you save it, and the key it is encrypted
                    with. Not stored, not logged, not sent.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Told to the router</dt>
                  <dd className="text-[var(--color-ink-soft)]">
                    Executing asks Jupiter for a route, which discloses the
                    pending trade to Jupiter before it is submitted. Inherent to
                    using a router, and not covered by the encryption.
                  </dd>
                </div>
              </dl>
              <a
                className="mt-3 inline-block text-[11px] underline underline-offset-2"
                href="https://github.com/Anshv784/silentedge/blob/main/docs/visibility.md"
                target="_blank"
                rel="noreferrer noopener"
              >
                The full classification
              </a>
            </Panel>

            <Receipts items={receipts} />

            {/* --- The shielded layer ---------------------------------- */}
            <section className="mt-5 border border-[var(--color-rule)] bg-[var(--color-panel)]">
              <header className="flex items-baseline justify-between border-b border-[var(--color-rule)] px-5 py-3">
                <h2 className="text-[13px] font-medium tracking-[0.02em]">
                  {strategy ? strategy.name : "Your strategy"}
                </h2>
                <span className="tabular text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-soft)]">
                  03
                </span>
              </header>

              {editing ? (
                <StrategyBuilder
                  maxSizeBps={sizeCap}
                  onCancel={() => setEditing(false)}
                  onSave={(s) => {
                    setStrategy(s);
                    setEditing(false);
                    void encryptAndSubmit(s);
                  }}
                />
              ) : strategy ? (
                <div className="px-5 py-4">
                  <ul className="tabular space-y-2 text-[13px]">
                    {strategy.rules.map((rule) => (
                      <li
                        key={rule.kind}
                        className="border-b border-[var(--color-rule)] pb-2"
                      >
                        {describeRule(rule)}
                      </li>
                    ))}
                  </ul>
                  {mxe && !mxe.live ? (
                    <div className="mt-3 border border-[var(--color-exposed)] bg-[var(--color-paper)] px-3 py-2 text-[11px] leading-relaxed">
                      <strong className="text-[var(--color-exposed)]">
                        Not protected yet.
                      </strong>{" "}
                      {mxe.reason} Your strategy is encrypted to a development
                      key, not to a live MPC cluster, so treat it as public.
                    </div>
                  ) : null}
                  {encryptError ? (
                    <p role="alert" className="mt-3 text-[12px] text-[var(--color-exposed)]">
                      {encryptError}
                    </p>
                  ) : null}
                  {pending ? (
                    <div className="mt-3 border border-[var(--color-signal)] px-3 py-2">
                      <p className="text-[11px] leading-relaxed">
                        <strong>
                          {pending.side === 1 ? "Buy" : "Sell"}{" "}
                          {pending.side === 1
                            ? `${Number(pending.amountIn) / 1e6} ${QUOTE_SYMBOL}`
                            : `${Number(pending.amountIn) / 1e9} ${BASE_SYMBOL}`}
                        </strong>{" "}
                        authorized by the computation and waiting to be spent.
                        It expires in about a minute.
                      </p>
                      <button
                        className="mt-2 border border-[var(--color-signal)] bg-[var(--color-signal)] px-3 py-1.5 text-[12px] text-white disabled:opacity-40"
                        onClick={executeNow}
                        disabled={executing}
                      >
                        {executing ? "Executing…" : "Execute it myself"}
                      </button>
                      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                        Anyone can submit this, so you never have to wait for
                        us. The side, size, price floor and expiry were fixed by
                        the computation — executing only chooses the moment.
                      </p>
                    </div>
                  ) : null}
                  {submittedVersion && mxeVersion === 0 && !converting ? (
                    <p className="mt-3 border border-[var(--color-exposed)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-exposed)]">
                      Saved but not armed. The cluster has not re-encrypted this
                      strategy to itself yet, so evaluations are refused and it
                      cannot trade. Only you can complete this step — save again
                      to retry.
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[12px] text-[var(--color-ink-soft)]">
                      {strategy.sizeBps / 100}% of the vault per trade
                      {encrypting
                        ? " · encrypting…"
                        : converting
                          ? " · handing to the cluster…"
                          : mxeVersion > 0
                            ? ` · armed (v${mxeVersion})`
                            : submittedVersion
                              ? " · saved, NOT armed"
                              : ""}
                    </span>
                    <button
                      className="border border-[var(--color-rule)] px-3 py-1.5 text-[12px] transition-colors hover:bg-[var(--color-paper)]"
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </button>
                  </div>
                </div>
              ) : (
                <div className="px-5 py-4">
                  <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                    {["Buy below", "Sell above", "Stop below", "Size per trade"].map(
                      (label) => (
                        <div
                          key={label}
                          className="flex items-baseline justify-between gap-4 border-b border-[var(--color-rule)] py-2.5"
                        >
                          <span className="text-[13px] text-[var(--color-ink-soft)]">
                            {label}
                          </span>
                          <span
                            className="redacted tabular rounded-[1px] px-2 text-[15px]"
                            aria-label="Not set"
                          >
                            000.00
                          </span>
                        </div>
                      )
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-lg text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                      These four numbers are the whole strategy. They will be
                      encrypted in your browser and evaluated inside multi-party
                      computation, so no server holds them in the clear. Your
                      trades stay public — enough of them will narrow these
                      values to an observer.
                    </p>
                    <button
                      className="border border-[var(--color-signal)] bg-[var(--color-signal)] px-4 py-2 text-[13px] text-white transition-opacity hover:opacity-90"
                      onClick={() => setEditing(true)}
                    >
                      Build a strategy
                    </button>
                  </div>
                </div>
              )}

              <footer className="border-t border-[var(--color-rule)] px-5 py-2.5 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                {strategy
                  ? "Encrypted in this browser before it was sent. The plaintext never left this tab; only ciphertext is on chain."
                  : "Nothing set yet."}
              </footer>
            </section>
          </>
        )}

        <footer className="mt-12 border-t border-[var(--color-rule)] pt-5 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
          Devnet build. Not audited. The operator cannot withdraw your funds, but
          can change the program until the upgrade authority is timelocked.
        </footer>
      </div>
    </main>
  );
}
