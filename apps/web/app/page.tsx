"use client";

import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { BASE_SYMBOL, QUOTE_SYMBOL, VAULT_SEED } from "@silentedge/config";
import { useVault } from "@/lib/use-vault";
import { Address, Figure, Panel, Tag } from "@/components/readouts";

// The wallet button reads `window` on mount, so it cannot be server-rendered.
const WalletButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-[38px] w-[152px]" /> }
);

export default function Page() {
  const { publicKey, connected } = useWallet();
  const v = useVault();

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
                    : "Not created yet. Creating a vault is a single transaction you sign."
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
                  </>
                ) : (
                  <div className="border-t border-[var(--color-rule)] py-8 text-center text-[13px] text-[var(--color-ink-soft)]">
                    No vault at this address yet.
                  </div>
                )}
              </Panel>
            </div>

            {/* --- The shielded layer ---------------------------------- */}
            <section className="mt-5 border border-[var(--color-rule)] bg-[var(--color-panel)]">
              <header className="flex items-baseline justify-between border-b border-[var(--color-rule)] px-5 py-3">
                <h2 className="text-[13px] font-medium tracking-[0.02em]">
                  Your strategy
                </h2>
                <span className="tabular text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-soft)]">
                  03
                </span>
              </header>
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
                    These four numbers are the whole strategy. They are encrypted
                    in your browser and evaluated inside multi-party computation,
                    so no server holds them in the clear. Your trades stay public
                    — enough of them will narrow these values to an observer.
                  </p>
                  <Tag kind="shielded" />
                </div>
              </div>
              <footer className="border-t border-[var(--color-rule)] px-5 py-2.5 text-[11px] text-[var(--color-ink-soft)]">
                Nothing set yet.
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
