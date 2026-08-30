"use client";

import { usePathname } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { WalletContext } from "@/components/wallet-context";
import { VaultProvider } from "@/lib/vault-store";
import { Shell } from "@/components/shell";

/**
 * The app layout.
 *
 * `<Shell>` moved here from the eight individual pages. That relocation is
 * what makes the shell's motion possible at all: a `layoutId` can only travel
 * between two elements that are mounted simultaneously, and while every page
 * rendered its own sidebar the active-row rule was destroyed and recreated on
 * every navigation instead of sliding.
 *
 * The content is keyed on the pathname so one page can leave while the next
 * arrives. `mode="wait"` rather than a cross-fade, because two dense pages
 * overlapping at 50% opacity is unreadable for the duration.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    // The reduced-motion guard lives here rather than at the root: the landing
    // page uses no JS animation at all, so it should not mount a provider for
    // a library it never loads.
    <MotionConfig reducedMotion="user">
    <WalletContext>
      <VaultProvider>
      <Shell>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={path}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </Shell>
      </VaultProvider>
    </WalletContext>
    </MotionConfig>
  );
}
