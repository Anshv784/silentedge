"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The on-chain price, pushed rather than polled.
 *
 * Solana's RPC exposes `accountSubscribe` over WebSocket, so the browser can be
 * told the instant the Pyth account changes instead of asking every few
 * seconds. That is what this does: one socket, no polling loop, and the value
 * lands the moment it is written on chain.
 *
 * Measured honestly, because it matters for what this can and cannot fix: the
 * devnet Pyth publisher updates roughly once a minute, not continuously. The
 * socket removes the up-to-4-second lag between a change and this page seeing
 * it — it does not make a slow feed tick faster, and nothing can. The visibly
 * moving line on the page is the 5-second candle series, which is a different
 * source and says so.
 *
 * There is no SDK here on purpose. `@solana/web3.js` would add well over a
 * hundred kilobytes to a marketing page to do what forty lines of `WebSocket`
 * and a base64 decode already do. Byte offsets match `app/api/oracle/route.ts`
 * and `lib/activity.ts`.
 *
 * Falls back to polling the relay if the socket cannot be opened — a blocked
 * WebSocket must degrade to a working page, not a blank one.
 */

export type OraclePrice = {
  price: number;
  publishedAt: number;
  /** How the value arrived, so the interface can say which. */
  via: "socket" | "poll";
};

const ORACLE =
  process.env.NEXT_PUBLIC_PYTH_SOL_USD ??
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

/** `https://…` → `wss://…`. The CSP allows wss://*.solana.com explicitly. */
const wsUrl = () => RPC.replace(/^http/, "ws");

/** PriceUpdateV2: i64 price @73, i32 exponent @89, i64 publish_time @93. */
function decode(b64: string): { price: number; publishedAt: number } | null {
  try {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const dv = new DataView(buf.buffer);
    const raw = dv.getBigInt64(73, true);
    const exponent = dv.getInt32(89, true);
    const publishedAt = Number(dv.getBigInt64(93, true));
    const price = Number(raw) * 10 ** exponent;
    if (!Number.isFinite(price) || price <= 0) return null;
    return { price, publishedAt };
  } catch {
    return null;
  }
}

export function useOraclePrice(): OraclePrice | null {
  const [value, setValue] = useState<OraclePrice | null>(null);
  const socketOk = useRef(false);

  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    /* The relay. Used for the very first paint — the socket only speaks when
       the account next changes, which on devnet can be a minute away, and an
       empty price for a minute is worse than one poll. Also the fallback if
       the socket never opens. */
    const once = () =>
      fetch("/api/oracle")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!alive || !j || j.error) return;
          // Never let a poll overwrite a fresher socket value.
          setValue((prev) =>
            prev && prev.via === "socket" && prev.publishedAt >= j.publishedAt
              ? prev
              : { price: j.price, publishedAt: j.publishedAt, via: "poll" }
          );
        })
        .catch(() => {});

    const startPolling = () => {
      if (poll) return;
      poll = setInterval(once, 5000);
    };

    const open = () => {
      if (!alive) return;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        startPolling();
        return;
      }

      ws.onopen = () => {
        attempts = 0;
        socketOk.current = true;
        ws?.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "accountSubscribe",
            params: [ORACLE, { encoding: "base64", commitment: "confirmed" }],
          })
        );
      };

      ws.onmessage = (e) => {
        if (!alive) return;
        let m: {
          method?: string;
          params?: { result?: { value?: { data?: string[] } } };
        };
        try {
          m = JSON.parse(e.data as string);
        } catch {
          return;
        }
        if (m.method !== "accountNotification") return;
        const b64 = m.params?.result?.value?.data?.[0];
        if (!b64) return;
        const d = decode(b64);
        if (d) setValue({ ...d, via: "socket" });
      };

      /* Reconnect with a backoff, and poll in the meantime. A dropped socket
         must not silently freeze the price — a stale number with no indication
         it stopped updating is the worst outcome here. */
      ws.onclose = () => {
        if (!alive) return;
        startPolling();
        attempts += 1;
        retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempts));
      };
      ws.onerror = () => ws?.close();
    };

    once();
    open();
    // If the socket has not opened in eight seconds, assume it will not.
    const guard = setTimeout(() => {
      if (!socketOk.current) startPolling();
    }, 8000);

    return () => {
      alive = false;
      clearTimeout(guard);
      if (retry) clearTimeout(retry);
      if (poll) clearInterval(poll);
      ws?.close();
    };
  }, []);

  return value;
}
