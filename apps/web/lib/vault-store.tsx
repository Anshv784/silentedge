"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { VAULT_PROGRAM_ID } from "@silentedge/config";
import { normalize, type Strategy } from "@silentedge/types";
import { deriveEncryptionKeypair, encryptStrategy } from "@silentedge/sdk";
import { useVault, type VaultView } from "@/lib/use-vault";
import { fetchMxePublicKey, type MxeKey } from "@/lib/mxe";
import {
  convertStrategy,
  readLimits,
  readListing,
  readMxeVersion,
  readPendingIntent,
  readableError,
  selfExecute,
  setListing,
  setStatus,
  submitStrategy,
  updateLimits,
  useProgram,
} from "@/lib/vault-program";
import {
  readActivity,
  readOraclePrice,
  vaultValueInQuote,
  type Activity,
} from "@/lib/activity";
import type { Receipt } from "@/components/vault-actions";

const PYTH_SOL_USD = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);

export type Limits = NonNullable<Awaited<ReturnType<typeof readLimits>>>;
type Listing = { listed: boolean; name: string };
type Oracle = { price: number; publishedAt: number };
/**
 * The authorization the MPC cluster signed, and the slot it dies at.
 *
 * `expiresAtSlot` was already being fetched by `readPendingIntent` and thrown
 * away here, so nothing could show how long an authorization had left. It is a
 * SLOT and not a wall-clock time: `INTENT_TTL_SLOTS = 180` in the program, and
 * slot duration drifts around its 400ms target. Anything rendering this must
 * say slots and gloss the seconds as approximate — a confident "M:SS" would be
 * inventing precision the chain does not have.
 */
type Pending = { side: number; amountIn: bigint; expiresAtSlot: bigint };

/**
 * One place that owns every read and write against the vault.
 *
 * Previously all of this lived inside the single app page, which meant a second
 * page could not show vault state without duplicating the polling — and two
 * copies of "is the strategy armed?" is exactly the kind of thing that drifts
 * apart and starts lying in one of them.
 */
export type VaultStore = VaultView & {
  program: ReturnType<typeof useProgram>;
  connected: boolean;
  owner: PublicKey | null;

  limits: Limits | null;
  listing: Listing | null;
  oracle: Oracle | null;
  activity: Activity[] | null;
  pending: Pending | null;
  /** Current slot, polled alongside the authorization so the two agree. */
  slot: number | null;
  receipts: Receipt[];

  /**
   * The strategy as this browser knows it. Kept in memory only, and only for
   * as long as the tab lives: a draft written to disk in the clear is a
   * strategy leak with extra steps. Once the tab reloads the thresholds are
   * genuinely unrecoverable — even to you — because the only other copy is
   * encrypted to the cluster.
   */
  draft: Strategy | null;
  setDraft: (s: Strategy | null) => void;

  mxe: MxeKey | null;
  /** Non-zero only once the cluster holds a strategy it can actually evaluate. */
  mxeVersion: number;
  submitted: boolean;
  /** Total vault value in quote units at the oracle price the program reads. */
  totalValue: number | null;

  busy: {
    encrypting: boolean;
    converting: boolean;
    executing: boolean;
    status: boolean;
    limits: boolean;
    listing: boolean;
  };
  error: string | null;
  actionError: string | null;
  clearError: () => void;

  record: (r: Receipt) => void;
  submitStrategy: (draft: Strategy, sizeCap: number) => Promise<void>;
  saveLimits: (next: Limits) => Promise<void>;
  changeStatus: (a: "pause" | "resume" | "stop") => Promise<void>;
  toggleListing: (name: string) => Promise<void>;
  executeNow: () => Promise<void>;
};

const Ctx = createContext<VaultStore | null>(null);

export function useVaultStore(): VaultStore {
  const c = useContext(Ctx);
  if (!c) throw new Error("useVaultStore must be used inside <VaultProvider>");
  return c;
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const { publicKey, connected, signMessage } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const v = useVault();

  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [draft, setDraft] = useState<Strategy | null>(null);
  const [mxe, setMxe] = useState<MxeKey | null>(null);
  const [mxeVersion, setMxeVersion] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [listing, setListingState] = useState<Listing | null>(null);
  const [oracle, setOracle] = useState<Oracle | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState({
    encrypting: false,
    converting: false,
    executing: false,
    status: false,
    limits: false,
    listing: false,
  });

  const flag = (k: keyof typeof busy, on: boolean) =>
    setBusy((b) => ({ ...b, [k]: on }));

  const record = useCallback(
    (r: Receipt) => {
      setReceipts((prev) => [r, ...prev]);
      v.refresh();
    },
    [v]
  );

  useEffect(() => {
    if (!connected) return;
    fetchMxePublicKey(connection, VAULT_PROGRAM_ID).then(setMxe);
  }, [connection, connected]);

  useEffect(() => {
    if (!program || !publicKey) return;
    readMxeVersion(program, publicKey).then(setMxeVersion).catch(() => {});
  }, [program, publicKey, receipts.length]);

  // Vault history, risk limits, listing and the oracle price the program reads.
  // All four come from the chain, so a reload shows the same thing and anything
  // an executor did on your behalf is visible too.
  useEffect(() => {
    if (!program || !publicKey || !v.vaultAddress) return;
    let alive = true;
    const load = async () => {
      const [a, l, o, li] = await Promise.all([
        readActivity(connection, v.vaultAddress!).catch(() => [] as Activity[]),
        readLimits(program, publicKey).catch(() => null),
        readOraclePrice(connection, PYTH_SOL_USD).catch(() => null),
        readListing(program, publicKey).catch(() => null),
      ]);
      if (!alive) return;
      setActivity(a);
      setLimits(l);
      setOracle(o);
      setListingState(li);
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
    const read = () => {
      readPendingIntent(program, publicKey)
        .then((i) => alive && setPending(i))
        .catch(() => {});
      // Read in the same tick as the intent so the countdown is never
      // comparing an expiry against a slot from a different moment.
      connection
        .getSlot()
        .then((s) => alive && setSlot(s))
        .catch(() => {});
    };
    read();
    const id = setInterval(read, 5_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [program, publicKey, connection, receipts.length]);

  /**
   * Conversion finishes in a callback, not in the transaction that queues it,
   * so the only honest signal is the on-chain version becoming non-zero.
   * `submit_strategy` zeroes it — that is what retires the previous strategy —
   * so any non-zero reading after a submission is this conversion, not a stale
   * one. Polling for it keeps the UI from claiming "armed" mid-flight.
   */
  const waitForConversion = useCallback(
    async (p: NonNullable<typeof program>, owner: PublicKey) => {
      for (let i = 0; i < 40; i++) {
        const now = await readMxeVersion(p, owner).catch(() => 0);
        if (now > 0) {
          setMxeVersion(now);
          return;
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
      throw new Error("the cluster did not finish converting in time");
    },
    []
  );

  /**
   * Encrypt in the browser, then submit only the ciphertext.
   *
   * The plaintext never leaves this function's scope: normalized, encrypted,
   * and handed to the transaction builder. No fetch, no storage, no logging of
   * the draft anywhere along the way.
   */
  const submit = useCallback(
    async (draft: Strategy, sizeCap: number) => {
      if (!publicKey || !program) {
        setActionError("Connect a wallet first.");
        return;
      }
      if (!signMessage) {
        setActionError(
          "This wallet cannot sign messages, and the encryption key is derived " +
            "from a signature. Nothing was submitted — try a wallet that supports " +
            "message signing."
        );
        return;
      }
      if (!mxe) {
        setActionError(
          "Still reading the cluster's encryption key. Nothing was submitted — " +
            "wait a moment and retry."
        );
        return;
      }
      // Refuse rather than encrypt to the development stand-in. `fetchMxePublicKey`
      // falls back to a fixed, public, in-repo constant on any error, so with a
      // real MXE deployed that fallback is what a transient RPC failure looks
      // like — and submitting anyway would publish a strategy anyone can decrypt
      // while the UI said "encrypted on chain".
      if (!mxe.live) {
        setActionError(
          "Not submitting: the MXE encryption key could not be read, so the " +
            "strategy would be encrypted to a public development key. Retry."
        );
        return;
      }

      flag("encrypting", true);
      setActionError(null);
      try {
        const keypair = await deriveEncryptionKeypair(signMessage);
        const encrypted = encryptStrategy(
          normalize(draft, sizeCap),
          mxe.key,
          keypair.privateKey
        );
        const signature = await submitStrategy(program, publicKey, encrypted);
        setDraft(draft);
        setSubmitted(true);
        setMxeVersion(0);
        record({
          signature,
          action: `Encrypt strategy "${draft.name}"`,
          at: Date.now(),
        });

        // Second signature, and the one that actually arms the bot. Submitting
        // stores a strategy only you can read; converting re-encrypts it to the
        // cluster, which is what lets evaluations run with nobody online.
        // Skipping it leaves a strategy that looks saved and can never fire.
        flag("converting", true);
        try {
          const convertSig = await convertStrategy(program, publicKey);
          record({
            signature: convertSig,
            action: "Hand strategy to the MPC cluster",
            at: Date.now(),
          });
          await waitForConversion(program, publicKey);
        } catch (e) {
          setActionError(
            `Strategy saved, but not yet armed: ${readableError(e)} ` +
              "It cannot trade until conversion succeeds. Save again to retry."
          );
        } finally {
          flag("converting", false);
        }
      } catch (e) {
        setActionError(readableError(e));
      } finally {
        flag("encrypting", false);
      }
    },
    [mxe, program, publicKey, record, signMessage, waitForConversion]
  );

  /**
   * Limits are enforced now, and the vault has no close instruction, so a bad
   * value chosen at creation would otherwise bind that vault forever. Saving
   * bumps the vault nonce, which invalidates any authorization already in
   * flight — an intent carries no copy of the envelope it was issued under.
   */
  const saveLimits = useCallback(
    async (next: Limits) => {
      if (!program || !publicKey) return;
      flag("limits", true);
      setActionError(null);
      try {
        const signature = await updateLimits(program, publicKey, next);
        setLimits(next);
        record({ signature, action: "Update risk limits", at: Date.now() });
      } catch (e) {
        setActionError(readableError(e));
      } finally {
        flag("limits", false);
      }
    },
    [program, publicKey, record]
  );

  /**
   * Pause, resume, or stop. Owner-only, and deliberately unable to trap funds:
   * `withdraw` never reads status, so the worst a status change can do is stop
   * new trading.
   */
  const changeStatus = useCallback(
    async (action: "pause" | "resume" | "stop") => {
      if (!program || !publicKey) return;
      if (
        action === "stop" &&
        !confirm(
          "Stop is permanent. The vault can never trade again, though you can always withdraw. Continue?"
        )
      ) {
        return;
      }
      flag("status", true);
      setActionError(null);
      try {
        const signature = await setStatus(program, publicKey, action);
        record({
          signature,
          action: `${action[0].toUpperCase()}${action.slice(1)} vault`,
          at: Date.now(),
        });
      } catch (e) {
        setActionError(readableError(e));
      } finally {
        flag("status", false);
      }
    },
    [program, publicKey, record]
  );

  const toggleListing = useCallback(
    async (name: string) => {
      if (!program || !publicKey || !listing) return;
      flag("listing", true);
      setActionError(null);
      try {
        const next = !listing.listed;
        const signature = await setListing(
          program,
          publicKey,
          next,
          next ? name : ""
        );
        setListingState({ listed: next, name: next ? name : "" });
        record({
          signature,
          action: next ? "List vault publicly" : "Unlist vault",
          at: Date.now(),
        });
      } catch (e) {
        setActionError(readableError(e));
      } finally {
        flag("listing", false);
      }
    },
    [listing, program, publicKey, record]
  );

  /**
   * Spend the pending authorization from this browser.
   *
   * Present so nobody has to trust our executor to be running, honest, or fast.
   * `execute_trade` is permissionless and every parameter was fixed by the
   * verified callback, so this is the same transaction the executor would send
   * — just paid for by you.
   */
  const executeNow = useCallback(async () => {
    if (!program || !publicKey || !pending) return;
    flag("executing", true);
    setActionError(null);
    try {
      const signature = await selfExecute(program, publicKey, pending);
      record({
        signature,
        action: `Execute authorized ${pending.side === 1 ? "buy" : "sell"}`,
        at: Date.now(),
      });
      setPending(null);
    } catch (e) {
      setActionError(readableError(e));
    } finally {
      flag("executing", false);
    }
  }, [pending, program, publicKey, record]);

  const totalValue = useMemo(
    () => vaultValueInQuote(v.vaultUsdc, v.vaultWrappedSol, oracle?.price ?? null),
    [v.vaultUsdc, v.vaultWrappedSol, oracle?.price]
  );

  const value: VaultStore = {
    ...v,
    program,
    connected,
    owner: publicKey ?? null,
    limits,
    listing,
    oracle,
    activity,
    pending,
    slot,
    receipts,
    draft,
    setDraft,
    mxe,
    mxeVersion,
    submitted,
    totalValue,
    busy,
    actionError,
    clearError: () => setActionError(null),
    record,
    submitStrategy: submit,
    saveLimits,
    changeStatus,
    toggleListing,
    executeNow,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
