"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  BASE_MINT,
  QUOTE_MINT,
  BASE_SYMBOL,
  QUOTE_SYMBOL,
  BASE_DECIMALS,
  QUOTE_DECIMALS,
  toBaseUnits,
} from "@silentedge/config";
import { BN } from "@coral-xyz/anchor";
import {
  createVault,
  deposit,
  withdraw,
  readableError,
  useProgram,
} from "@/lib/vault-program";

export type Receipt = {
  signature: string;
  action: string;
  at: number;
};

type Asset = { mint: PublicKey; symbol: string; decimals: number };

const ASSETS: Asset[] = [
  { mint: QUOTE_MINT, symbol: QUOTE_SYMBOL, decimals: QUOTE_DECIMALS },
  { mint: BASE_MINT, symbol: BASE_SYMBOL, decimals: BASE_DECIMALS },
];

const inputClass = "field tabular";
const buttonClass = "btn btn-primary";

export function CreateVault({
  owner,
  onDone,
}: {
  owner: PublicKey;
  onDone: (r: Receipt) => void;
}) {
  const program = useProgram();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!program) return;
    setBusy(true);
    setError(null);
    try {
      const signature = await createVault(program, owner);
      onDone({ signature, action: "Create vault", at: Date.now() });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-[var(--color-rule)] px-5 py-6 text-center">
      <p className="mx-auto mb-4 max-w-xs text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
        Creating one is a single transaction. The vault is controlled by the
        program, and only your address can withdraw from it.
      </p>
      <button className="btn btn-primary btn-lg w-full" onClick={run} disabled={busy}>
        {busy ? "Confirm in your wallet…" : "Create vault"}
      </button>
      {error ? (
        <p role="alert" className="mt-3 text-[12px] text-[var(--color-neg)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Transfer({
  owner,
  direction,
  available,
  onDone,
}: {
  owner: PublicKey;
  direction: "deposit" | "withdraw";
  /** Spendable balance per symbol, for the Max control and pre-flight checks. */
  available: Record<string, number>;
  onDone: (r: Receipt) => void;
}) {
  const program = useProgram();
  const [asset, setAsset] = useState<Asset>(ASSETS[0]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDeposit = direction === "deposit";
  // Deposits are USDC-only for now: putting SOL in would require wrapping it
  // first, which is its own flow. Withdrawals cover both, because trading
  // leaves wrapped SOL in the vault.
  const assets = isDeposit ? [ASSETS[0]] : ASSETS;
  const max = available[asset.symbol] ?? 0;
  const units = toBaseUnits(value, asset.decimals);
  const parsed = units === null ? null : new BN(units.toString());
  const overBalance =
    units !== null && Number(units) / 10 ** asset.decimals > max;

  async function run() {
    if (!program || !parsed) return;
    setBusy(true);
    setError(null);
    try {
      const fn = isDeposit ? deposit : withdraw;
      const signature = await fn(program, owner, asset.mint, parsed);
      onDone({
        signature,
        action: `${isDeposit ? "Deposit" : "Withdraw"} ${value} ${asset.symbol}`,
        at: Date.now(),
      });
      setValue("");
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <label
          htmlFor={`${direction}-amount`}
          className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-faint)]"
        >
          {isDeposit ? "Deposit" : "Withdraw"}
        </label>
        <button
          type="button"
          onClick={() => setValue(max > 0 ? String(max) : "")}
          className="tabular text-[11px] text-[var(--color-ink-soft)] underline underline-offset-2 transition-colors hover:text-[var(--color-ink)]"
        >
          {max.toLocaleString(undefined, { maximumFractionDigits: 4 })} available
        </button>
      </div>

      <div className="flex gap-2">
        <input
          id={`${direction}-amount`}
          className={inputClass}
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          disabled={busy}
        />
        {assets.length > 1 ? (
          <select
            aria-label="Asset"
            className={`${inputClass} w-auto`}
            value={asset.symbol}
            onChange={(e) =>
              setAsset(ASSETS.find((a) => a.symbol === e.target.value)!)
            }
            disabled={busy}
          >
            {assets.map((a) => (
              <option key={a.symbol} value={a.symbol}>
                {a.symbol}
              </option>
            ))}
          </select>
        ) : (
          <span className="tabular flex items-center rounded-md border border-[var(--color-rule-strong)] px-3 text-[12px] text-[var(--color-ink-faint)]">
            {asset.symbol}
          </span>
        )}
        <button
          className={buttonClass}
          onClick={run}
          disabled={busy || !parsed || overBalance}
        >
          {busy ? "…" : isDeposit ? "Deposit" : "Withdraw"}
        </button>
      </div>

      {value !== "" && parsed === null ? (
        <p className="mt-2 text-[11px] text-[var(--color-neg)]">
          Enter an amount above zero, with at most {asset.decimals} decimal
          places.
        </p>
      ) : null}
      {overBalance ? (
        <p className="mt-2 text-[11px] text-[var(--color-neg)]">
          That is more than the {max.toLocaleString()} {asset.symbol} available.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-[var(--color-neg)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
