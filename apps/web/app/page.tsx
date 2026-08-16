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
import { submitStrategy, readableError, useProgram } from "@/lib/vault-program";
import { VAULT_PROGRAM_ID } from "@silentedge/config";
import { useConnection } from "@solana/wallet-adapter-react";

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

  useEffect(() => {
    if (!connected) return;
    fetchMxePublicKey(connection, VAULT_PROGRAM_ID).then(setMxe);
  }, [connection, connected]);

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
        normalize(draft, 1000),
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
            <h1 className="text-[15px] font-medium tracking-[0.04em]">
              SilentEdge
            </h1>
            <p className="mt-1 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
              A vault only you can withdraw from, and a strategy only the
              computation can read.
            </p>
          </div>
          <WalletButton />
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
                  maxSizeBps={1000}
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
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[12px] text-[var(--color-ink-soft)]">
                      {strategy.sizeBps / 100}% of the vault per trade
                      {encrypting
                        ? " · encrypting…"
                        : submittedVersion
                          ? ` · encrypted on chain (v${submittedVersion})`
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
