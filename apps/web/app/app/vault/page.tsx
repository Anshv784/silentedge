"use client";

import Link from "next/link";
import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { WalletButton } from "@/components/shell";
import {
  Alert,
  Badge,
  Block,
  BlockHead,
  Gate,
  Mono,
  PageHead,
  Prov,
  Reveal,
  Row,
} from "@/components/ui";
import { useVaultStore, type Limits } from "@/lib/vault-store";
import { VAULT_SEED } from "@silentedge/config";

const FIELDS: [keyof Limits, string, number, number, number][] = [
  ["sizeBps", "Trade size %", 0.01, 100, 100],
  ["maxTradeBps", "Max per trade %", 0.01, 50, 100],
  ["maxSlippageBps", "Max slippage %", 0.01, 5, 100],
  ["cooldownSeconds", "Cooldown (s)", 0, 3600, 1],
];

/**
 * The visibility classification — the centrepiece of this page.
 *
 * Three classes, not two, because two would be a lie. `public` and `private`
 * take the reserved provenance rails: amber means a stranger can read it on
 * chain, teal means it never leaves the computation. The two rows that are
 * neither — a disclosure made off chain to a named third party, and a fact
 * about governance rather than about data — take the neutral rail. Painting
 * either of those amber or teal would claim something about them that is not
 * true, and this section is the one place on the site where that would matter
 * most.
 *
 * Every `d` string is verbatim from the previous build.
 */
const VISIBILITY: {
  t: string;
  d: string;
  prov?: "public" | "private";
  label: string;
}[] = [
  {
    t: "Public, on chain",
    d: "Your vault, its balances, every risk limit including the trade size, every authorization and every trade. Anyone can read all of it.",
    prov: "public",
    label: "Exposed · on chain",
  },
  {
    t: "Encrypted",
    d: "Your three price thresholds, and nothing else. No single party can read them — not us, not any one node.",
    prov: "private",
    label: "Shielded · in MPC",
  },
  {
    t: "Leaks over time",
    d: "Every trade is a public clue about the threshold behind it. Enough trades narrow your rules to a tight range. They are unread, not unknowable.",
    prov: "public",
    label: "Exposed · inferable",
  },
  {
    t: "Never leaves this tab",
    d: "The draft before you save it, and the key it is encrypted with. Not stored, not logged, not sent.",
    prov: "private",
    label: "Shielded · never sent",
  },
  {
    t: "Told to the router",
    d: "Executing asks Jupiter for a route, which discloses the pending trade to Jupiter before it is submitted. Inherent to using a router, and not covered by the encryption.",
    label: "Neither · off chain, to a third party",
  },
  {
    t: "Upgradeable",
    d: "The upgrade authority is still a single key. Until it moves to a timelocked multisig, “non-custodial” describes the deployed code and not every future version of it.",
    label: "Neither · governance",
  },
];

/**
 * The wallet adapter pins its own trigger to 36px with `!important` from its
 * stylesheet, so a gate — where connecting is the only action on the screen —
 * has to override it at the same weight to reach a 44px target. The values
 * match `.btn-lg`.
 */
const CONNECT_44 =
  "[&_.wallet-adapter-button-trigger]:!h-11 [&_.wallet-adapter-button-trigger]:!px-5 [&_.wallet-adapter-button-trigger]:!text-[15px]";

/**
 * Everything about the vault that is not a balance or a strategy.
 *
 * Kept on its own page rather than stacked under the overview, because these
 * are settings you change rarely and read carefully — and three of the blocks
 * here exist to state limits of the product rather than to configure it.
 *
 * The page builds to the visibility classification, which is set at reading
 * scale on its own ruled field rather than compressed into a table of badges.
 * Everything above it — limits, status, listing — is public on chain, so those
 * three blocks carry the exposed rail and it lines up down the column.
 */
export default function VaultSettings() {
  const s = useVaultStore();
  const [editing, setEditing] = useState(false);
  const [listName, setListName] = useState("");

  if (!s.connected) {
    return (
      <>
        <PageHead title="Vault" />
        <div className="mx-auto max-w-xl pt-12">
          <Gate
            title="Connect a wallet"
            prov="public"
            action={
              <div className={CONNECT_44}>
                <WalletButton />
              </div>
            }
          >
            Vault settings are read from the chain for the connected address.
          </Gate>
        </div>
      </>
    );
  }

  if (!s.vaultStatus) {
    return (
      <>
        <PageHead title="Vault" />
        <div className="mx-auto max-w-xl pt-12">
          <Gate
            title="No vault yet"
            prov="public"
            action={
              <Link href="/app" className="btn btn-lg btn-primary">
                Create one on the overview
              </Link>
            }
          >
            Settings appear once the account exists.
          </Gate>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Vault"
        subtitle="Limits, status and what is visible"
        actions={
          <Badge tone={s.vaultStatus === "active" ? "good" : "warn"} dot>
            {s.vaultStatus}
          </Badge>
        }
      />

      <Reveal as="div" className="ledger lg:grid-cols-2">
        {/* The alert lives in the lattice rather than above it, so its exit
            leaves no dead margin behind. */}
        <div className="lg:col-span-2">
          <AnimatePresence initial={false}>
            {s.actionError ? (
              <Alert key="action-error" tone="bad" title="Last action failed.">
                {s.actionError}{" "}
                <button
                  onClick={s.clearError}
                  className="underline underline-offset-2"
                >
                  Dismiss
                </button>
              </Alert>
            ) : null}
          </AnimatePresence>
        </div>

        {/* -------------------------------------------------- risk limits */}
        <Block prov="public">
          <BlockHead
            title="Risk limits"
            eyebrow="On chain"
            hint="Enforced by the program, not by this page."
            right={
              !editing ? (
                <button className="btn btn-ghost" onClick={() => setEditing(true)}>
                  Edit
                </button>
              ) : null
            }
          />
          {!s.limits ? (
            <p className="text-caption text-[var(--color-ink-soft)]">
              Reading limits…
            </p>
          ) : editing ? (
            <form
              className="grid grid-cols-2 gap-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const next = { ...s.limits! };
                for (const [key, , , , scale] of FIELDS) {
                  next[key] = Math.round(Number(f.get(key)) * scale) as never;
                }
                await s.saveLimits(next);
                setEditing(false);
              }}
            >
              {FIELDS.map(([key, label, min, max, scale]) => (
                <label key={key} className="block">
                  <span className="text-caption text-[var(--color-ink-soft)]">
                    {label}
                  </span>
                  <input
                    name={key}
                    type="number"
                    step="any"
                    min={min}
                    max={max}
                    defaultValue={(s.limits![key] as number) / scale}
                    className="field tabular mt-2"
                  />
                </label>
              ))}
              <div className="col-span-2 flex gap-2">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={s.busy.limits}
                >
                  {s.busy.limits ? "Saving…" : "Save limits"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </div>
              <p className="col-span-2 text-caption text-[var(--color-ink-soft)]">
                Saving bumps the vault nonce, which cancels any authorization
                currently in flight — a decision made under the old limits cannot
                execute under the new ones.
              </p>
            </form>
          ) : (
            <div>
              <Row
                label="Trade size"
                value={`${s.limits.sizeBps / 100}% of the spendable balance`}
              />
              <Row
                label="Max per trade"
                value={`${s.limits.maxTradeBps / 100}%`}
                hint="entries only"
              />
              <Row label="Max slippage" value={`${s.limits.maxSlippageBps / 100}%`} />
              <Row
                label="Cooldown"
                value={`${s.limits.cooldownSeconds}s`}
                hint="between entries"
              />
              <Row label="Max price age" value={`${s.limits.maxOracleStalenessSec}s`} />
              <Row
                label="Max price uncertainty"
                value={`${s.limits.maxConfBps / 100}%`}
              />
            </div>
          )}
          <p className="mt-6 text-caption text-[var(--color-ink-soft)]">
            Exits are exempt from the size cap, the cooldown and the deviation
            band on purpose: a stop-loss sells the whole position, a cap can never
            exceed half of it, and refusing an exit because the price fell further
            would disarm the stop in the exact move it exists for. One stored
            limit — a daily loss limit — is <strong>not enforced</strong> at all;
            see SECURITY.md rather than reading it as protection.
          </p>
        </Block>

        {/* ------------------------------------------------------- status */}
        <Block prov="public">
          <BlockHead
            title="Trading status"
            eyebrow="On chain"
            hint="Owner-only, and unable to trap funds: withdraw never reads status."
          />
          <div className="flex flex-wrap gap-2">
            {s.vaultStatus === "active" ? (
              <button
                className="btn btn-ghost"
                onClick={() => s.changeStatus("pause")}
                disabled={s.busy.status}
              >
                Pause trading
              </button>
            ) : null}
            {s.vaultStatus === "paused" ? (
              <button
                className="btn btn-ghost"
                onClick={() => s.changeStatus("resume")}
                disabled={s.busy.status}
              >
                Resume
              </button>
            ) : null}
            {s.vaultStatus !== "stopped" ? (
              <button
                className="btn btn-danger"
                onClick={() => s.changeStatus("stop")}
                disabled={s.busy.status}
              >
                Stop permanently
              </button>
            ) : null}
          </div>
          <p className="mt-5 text-caption text-[var(--color-ink-soft)]">
            Withdrawals keep working in every state — pausing can never trap your
            funds. Stopping is permanent: the vault can never trade again.
          </p>

          <div className="mt-7 border-t border-[var(--color-rule)] pt-6">
            <div className="flex items-baseline justify-between gap-4">
              <span className="u-label text-[var(--color-ink-soft)]">
                Vault address
              </span>
              <Mono copy>{s.vaultAddress?.toString()}</Mono>
            </div>
            <p className="tabular mt-2 text-caption text-[var(--color-ink-soft)]">
              seeds = &quot;{VAULT_SEED}&quot; + your address
            </p>
            <p className="mt-4 text-caption text-[var(--color-ink-soft)]">
              Withdrawals go to your address only — the destination is derived,
              not chosen, so there is no field an attacker could point elsewhere.
            </p>
          </div>
        </Block>

        {/* ---------------------------------------------------- discovery */}
        <Block prov="public">
          <BlockHead
            title="Discovery"
            eyebrow="On chain"
            hint="Off by default. Listing changes what is findable, not what is readable."
            right={
              s.listing ? (
                <Badge tone={s.listing.listed ? "accent" : "neutral"}>
                  {s.listing.listed ? "Listed" : "Private"}
                </Badge>
              ) : null
            }
          />
          {!s.listing ? (
            <p className="text-caption text-[var(--color-ink-soft)]">Reading…</p>
          ) : s.listing.listed ? (
            <>
              <p className="max-w-[58ch]">
                Listed as <strong>{s.listing.name || "Unnamed vault"}</strong>.
                Anyone can find this vault and see its balances, risk limits and
                executed trades — all of which were already public on chain. Your
                strategy stays encrypted.
              </p>
              <button
                className="btn btn-ghost mt-5"
                onClick={() => s.toggleListing("")}
                disabled={s.busy.listing}
              >
                {s.busy.listing ? "Working…" : "Unlist"}
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                s.toggleListing(listName.trim());
              }}
            >
              <p className="max-w-[58ch] text-[var(--color-ink-soft)]">
                Listing makes this vault appear in Discover. It publishes nothing
                new — balances, limits and trades are already readable by anyone —
                and it cannot expose your strategy, because no instruction in the
                program can.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <input
                  className="field flex-1"
                  maxLength={32}
                  placeholder="Public name (optional)"
                  value={listName}
                  onChange={(e) => setListName(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={s.busy.listing}
                >
                  {s.busy.listing ? "Working…" : "List publicly"}
                </button>
              </div>
            </form>
          )}
        </Block>

        {/* --------------------------------------------------------- fees
            Neutral rail: costs are not a class of vault data, and claiming
            them as either public or shielded would be noise on the one page
            where those two rails have to keep meaning something. */}
        <Block className="prov">
          <BlockHead
            title="Costs"
            eyebrow="Not a data class"
            hint="No protocol fee. What you do pay, and to whom."
          />
          <dl className="space-y-5">
            <div>
              <dt className="font-medium">SilentEdge takes nothing</dt>
              <dd className="mt-1 text-caption text-[var(--color-ink-soft)]">
                No instruction in the program can send value anywhere except back
                to you. That is structural, not a setting.
              </dd>
            </div>
            <div>
              <dt className="font-medium">You pay Solana</dt>
              <dd className="mt-1 text-caption text-[var(--color-ink-soft)]">
                Rent for the vault account, and a transaction fee for each deposit,
                withdrawal and strategy change. Fractions of a cent.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Someone pays to run it</dt>
              <dd className="mt-1 text-caption text-[var(--color-ink-soft)]">
                Each evaluation and each trade costs a transaction plus a
                computation fee. Both are permissionless, so anyone can pay them —
                today that is us, and there is no mechanism that reimburses it.
              </dd>
            </div>
            <div>
              {/* --color-exposed doubles as the caution tone on a notice; the
                  "be careful" reading is the same job as "readable by anyone". */}
              <dt className="font-medium text-[var(--color-exposed)]">
                The swap is the real cost
              </dt>
              <dd className="mt-1 text-caption text-[var(--color-ink-soft)]">
                Every trade pays spread and price impact, bounded only by your own
                max slippage. It is charged whether or not anyone calls it a fee.
              </dd>
            </div>
          </dl>
          <a
            className="mt-6 inline-block text-caption text-[var(--color-signal-hi)] underline underline-offset-2"
            href="https://github.com/Anshv784/silentedge/blob/main/FEES.md"
            target="_blank"
            rel="noreferrer noopener"
          >
            Full breakdown
          </a>
        </Block>
      </Reveal>

      {/* --------------------------------------------------- visibility
          The page builds to this. Six cells on their own ruled field, each
          declaring its class with the rail rather than with a badge in a
          table, so the three classes read as columns of colour before a
          single word is read. */}
      <Reveal className="mt-20">
        <div className="u-label text-[var(--color-ink-soft)]">What is visible</div>
        <h2 className="mt-3 max-w-[34ch] text-title">
          Being precise about this is the product.
        </h2>

        <div className="ledger mt-8 sm:grid-cols-2">
          {VISIBILITY.map((v) => (
            <Block key={v.t} prov={v.prov} className={v.prov ? "" : "prov"}>
              {v.prov ? (
                <Prov tone={v.prov}>{v.label}</Prov>
              ) : (
                <span className="u-label inline-flex items-center gap-1.5 text-[var(--color-ink-soft)]">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 shrink-0 bg-[var(--color-rule-strong)]"
                  />
                  {v.label}
                </span>
              )}
              <h3 className="mt-4 text-lead font-medium">{v.t}</h3>
              <p className="mt-3 max-w-[54ch] text-[var(--color-ink-soft)]">
                {v.d}
              </p>
            </Block>
          ))}
        </div>

        <p className="mt-6 text-caption text-[var(--color-ink-soft)]">
          <a
            className="text-[var(--color-signal-hi)] underline underline-offset-2"
            href="https://github.com/Anshv784/silentedge/blob/main/docs/privacy.md"
            target="_blank"
            rel="noreferrer noopener"
          >
            The full classification
          </a>
        </p>
      </Reveal>
    </>
  );
}
