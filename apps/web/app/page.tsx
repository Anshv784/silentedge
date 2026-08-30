import type { Metadata } from "next";
import { Landing } from "@/components/landing";

export const metadata: Metadata = {
  title: "SilentEdge — trading rules you do not have to publish",
  description:
    "Run a rule-based trading strategy on Solana without handing anyone your funds, and without publishing the rules you trade on. Devnet, unaudited, and precise about what it does not do.",
};

/**
 * The public landing page.
 *
 * A thin server component so the metadata above stays static; the page itself
 * is a client component because its centrepiece is the real charting terminal
 * rendering live prices, not a picture of one.
 */
export default function Page() {
  return <Landing />;
}
