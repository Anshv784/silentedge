import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const display = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SilentEdge — your bot trades, your prices stay unread",
  description:
    "Set a price to buy, a price to sell, a price to stop. They are encrypted in your browser and evaluated by a network where no single node holds them whole. Devnet, unaudited, open source.",
};

/**
 * The root layout.
 *
 * Deliberately holds almost nothing. There is no theme provider, no
 * `data-theme` attribute, no `suppressHydrationWarning`, and — most importantly
 * — no render-blocking inline script. The previous build ran a synchronous
 * script in `<head>` on every page load to restore a saved theme before first
 * paint. There is one identity now, so the script, the five theme blocks and
 * the picker are all gone.
 *
 * `WalletContext` is not here either: it pulls in the whole Solana wallet
 * stack, and the marketing page has no wallet on it. It lives in
 * `app/app/layout.tsx`, so only the routes that connect a wallet pay for it.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>
        <div className="ground" aria-hidden />
        {children}
      </body>
    </html>
  );
}
