"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import {
  BASE_MINT,
  QUOTE_MINT,
  deriveVaultPda,
  BASE_DECIMALS,
  QUOTE_DECIMALS,
} from "@silentedge/config";

export type VaultStatus = "active" | "paused" | "stopped";

export type VaultView = {
  loading: boolean;
  error: string | null;
  /** Native SOL in the connected wallet. */
  walletSol: number | null;
  /** USDC in the connected wallet. */
  walletUsdc: number | null;
  vaultAddress: PublicKey | null;
  /** null when the vault has not been created yet. */
  vaultStatus: VaultStatus | null;
  vaultUsdc: number | null;
  vaultWrappedSol: number | null;
  refresh: () => void;
};

/** Byte offset of `status` within VaultConfig, per programs/vault/src/state.rs. */
const STATUS_OFFSET =
  8 + // anchor discriminator
  32 + // owner
  32 + // base_mint
  32 + // quote_mint
  18; // RiskLimits: 2+2+2+4+4+2+2

const STATUSES: VaultStatus[] = ["active", "paused", "stopped"];

async function tokenAmount(
  connection: ReturnType<typeof useConnection>["connection"],
  owner: PublicKey,
  mint: PublicKey,
  decimals: number,
  offCurve = false
): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner, offCurve);
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 10 ** decimals;
  } catch {
    // No ATA yet is a zero balance, not an error.
    return 0;
  }
}

export function useVault(): VaultView {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Omit<VaultView, "refresh">>({
    loading: false,
    error: null,
    walletSol: null,
    walletUsdc: null,
    vaultAddress: null,
    vaultStatus: null,
    vaultUsdc: null,
    vaultWrappedSol: null,
  });

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!publicKey) {
      setState((s) => ({
        ...s,
        loading: false,
        error: null,
        walletSol: null,
        walletUsdc: null,
        vaultAddress: null,
        vaultStatus: null,
        vaultUsdc: null,
        vaultWrappedSol: null,
      }));
      return;
    }

    let cancelled = false;
    const vaultAddress = deriveVaultPda(publicKey);
    setState((s) => ({ ...s, loading: true, error: null, vaultAddress }));

    (async () => {
      try {
        const [lamports, walletUsdc, vaultAccount, vaultUsdc, vaultWrappedSol] =
          await Promise.all([
            connection.getBalance(publicKey),
            tokenAmount(connection, publicKey, QUOTE_MINT, QUOTE_DECIMALS),
            connection.getAccountInfo(vaultAddress),
            tokenAmount(connection, vaultAddress, QUOTE_MINT, QUOTE_DECIMALS, true),
            tokenAmount(connection, vaultAddress, BASE_MINT, BASE_DECIMALS, true),
          ]);
        if (cancelled) return;

        // Read the status enum directly rather than pulling Anchor into the
        // bundle for one byte. The offset is asserted against state.rs above.
        let vaultStatus: VaultStatus | null = null;
        if (vaultAccount && vaultAccount.data.length > STATUS_OFFSET) {
          vaultStatus = STATUSES[vaultAccount.data[STATUS_OFFSET]] ?? null;
        }

        setState({
          loading: false,
          error: null,
          walletSol: lamports / 10 ** BASE_DECIMALS,
          walletUsdc,
          vaultAddress,
          vaultStatus,
          vaultUsdc: vaultAccount ? vaultUsdc : null,
          vaultWrappedSol: vaultAccount ? vaultWrappedSol : null,
        });
      } catch (e) {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : "Could not reach the network.",
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, nonce]);

  return { ...state, refresh };
}
