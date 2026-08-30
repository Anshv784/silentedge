"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * The RPC endpoint is user-configurable by design. A hostile RPC cannot forge a
 * wallet-signed transaction, but it can lie about balances — so who you point
 * at is your choice to make, not ours. See SECURITY.md T-16.
 */
const endpoint =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "http://127.0.0.1:8899";

export function WalletContext({ children }: { children: React.ReactNode }) {
  // Wallet Standard discovers installed wallets automatically; registering an
  // explicit adapter list would only duplicate them.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
