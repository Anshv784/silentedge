"use client";

import { useEffect, useState } from "react";

/**
 * THE MACHINE — the animated explanation of what this product does.
 *
 * Four earlier versions of this site described the architecture in prose and a
 * judge read none of it. This is the same explanation as a three-beat loop with
 * one caption line per beat: the rules go in and get sealed, the sealed thing
 * splits across a cluster, a signed decision comes out and the trade lands on a
 * public chain.
 *
 * It is deliberately not a picture of the real system's internals — it is a
 * diagram, and the caption under it says which parts are real. The price it
 * shows IS real: it is the same live figure the hero prints.
 *
 * Implementation notes, because the point of this file is that it is cheap:
 *   - One `setInterval` incrementing an integer every 2.6s. There is no render
 *     loop, no rAF, no scroll listener.
 *   - Everything that moves is `transform` or `opacity`, so the compositor
 *     handles it and the main thread stays free.
 *   - The whole thing is ~40 DOM nodes and no images.
 */

const BEATS = [
  {
    caption: "Three prices go in. They are sealed in your browser.",
    detail: "buy under · sell over · stop below",
  },
  {
    caption: "Split across the cluster. No single node holds a whole number.",
    detail: "multi-party computation",
  },
  {
    caption: "A signed decision comes out. The trade lands on a public chain.",
    detail: "BUY · SELL · HOLD",
  },
];

/** What each node is shown holding. Nonsense by construction — no single node
 *  holds a whole number, and the point of the beat is that these are useless
 *  on their own. Fixed so they survive hydration and never imply live data. */
const SHARES = ["c1·7e", "0a·b4", "94·2f", "e6·38", "5d·d1"];

/** The five node positions, as percentages of the stage. */
const NODES = [
  { x: 12, y: 18 },
  { x: 78, y: 10 },
  { x: 90, y: 62 },
  { x: 50, y: 84 },
  { x: 8, y: 66 },
];

export function Machine({ price }: { price: number | null }) {
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setBeat((b) => (b + 1) % 3), 2600);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="select-none">
      <div
        className="slab slab-hi relative aspect-[5/4] w-full overflow-hidden"
        data-beat={beat}
        role="img"
        aria-label={`Diagram, step ${beat + 1} of 3: ${BEATS[beat].caption}`}
      >
        {/* ---------------------------------------------------- beat 0 */}
        {/* Three price cards drop in and flip face-down to lock. */}
        <div
          className="absolute inset-0 flex items-center justify-center gap-3 transition-opacity duration-300"
          style={{ opacity: beat === 0 ? 1 : 0 }}
          aria-hidden
        >
          {["BUY", "SELL", "STOP"].map((label, i) => (
            <div
              key={label}
              className="relative h-[104px] w-[86px]"
              style={{ perspective: "600px" }}
            >
              <div
                className="absolute inset-0 transition-transform duration-500"
                style={{
                  transformStyle: "preserve-3d",
                  transform: beat === 0 ? "rotateY(0deg)" : "rotateY(180deg)",
                  transitionDelay: `${i * 90}ms`,
                  transitionTimingFunction: "var(--ease-pop)",
                }}
              >
                {/* face — readable */}
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-2xl border-[3px]"
                  style={{
                    backfaceVisibility: "hidden",
                    borderColor: "var(--color-cyan)",
                    background: "color-mix(in srgb, var(--color-cyan) 12%, transparent)",
                  }}
                >
                  <span className="mono text-[10px] tracking-[0.14em] text-[var(--color-cyan)]">
                    {label}
                  </span>
                  <span className="mono tnum text-[18px] font-bold text-[var(--color-text)]">
                    {price === null
                      ? "—"
                      : Math.round(price * (label === "BUY" ? 0.96 : label === "SELL" ? 1.06 : 0.9))}
                  </span>
                  {/* Per card, because "buy under / sell over / stop below"
                      sitting once in the caption made three numbered cards
                      read as three of the same thing. */}
                  <span className="mono text-[9px] tracking-[0.1em] text-[var(--color-text-3)]">
                    {label === "BUY" ? "UNDER" : label === "SELL" ? "OVER" : "BELOW"}
                  </span>
                </div>
                {/* back — sealed */}
                <div
                  className="absolute inset-0 flex items-center justify-center rounded-2xl border-[3px]"
                  style={{
                    backfaceVisibility: "hidden",
                    transform: "rotateY(180deg)",
                    borderColor: "var(--color-magenta)",
                    background: "var(--color-magenta)",
                    backgroundImage:
                      "radial-gradient(circle, rgba(11,6,32,.55) 1px, transparent 1.2px)",
                    backgroundSize: "5px 5px",
                  }}
                >
                  <Lock />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ---------------------------------------------------- beat 1 */}
        {/* The sealed block splits into three shards that fan to five nodes. */}
        <div
          className="absolute inset-0 transition-opacity duration-300"
          style={{ opacity: beat === 1 ? 1 : 0 }}
          aria-hidden
        >
          {/* The links, drawn once as one static SVG. Five loose dots on a
              large stage read as an empty box; the same five wired to a centre
              read as a cluster, which is the whole point of the beat. */}
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {NODES.map((n, i) => (
              <line
                key={i}
                x1="50"
                y1="50"
                x2={n.x + 2}
                y2={n.y + 2}
                stroke="var(--color-stroke)"
                strokeWidth="0.4"
                strokeDasharray="2 2"
              />
            ))}
          </svg>
          {NODES.map((n, i) => (
            /* Dot and label are positioned separately, not stacked. Stacked and
               centred together, a 44px shard arriving on the node covered the
               label — which is the one part of this beat that carries the
               claim. The dot sits on the point; the label hangs below it. */
            <span key={i}>
              <span
                className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                style={{
                  left: `${n.x + 2}%`,
                  top: `${n.y + 2}%`,
                  borderColor: "var(--color-magenta)",
                  background: "var(--color-deep)",
                }}
              />
              {/* Each node's share. Fixed strings, not random: a value that
                  changed every render would be a lie about a computation that
                  is not running, and would break hydration. They are nonsense
                  on purpose — that IS the claim being illustrated. */}
              <span
                className="mono absolute -translate-x-1/2 text-[8px] tracking-[0.08em] text-[var(--color-text-3)]"
                style={{
                  left: `${n.x + 2}%`,
                  top: `calc(${n.y + 2}% + 26px)`,
                }}
              >
                {SHARES[i]}
              </span>
            </span>
          ))}
          {[0, 1, 2].map((i) => (
            /* Two nested elements on purpose. `orbit` animates `transform`, so
               putting both the fan-out translate and the orbit on one node
               means the keyframes win and all three shards spin on top of each
               other in the middle. The outer one travels; the inner one
               orbits. */
            <span
              key={i}
              className="absolute h-9 w-9"
              style={{
                /* Percentages, matching NODES, so a shard actually arrives AT
                   the node it belongs to. The old version travelled a px
                   offset scaled off the same numbers, which drifts with the
                   stage width — the shards landed near nothing and the beat
                   read as three tiles floating in a box. */
                left: beat === 1 ? `${NODES[i].x + 2}%` : "50%",
                top: beat === 1 ? `${NODES[i].y + 2}%` : "50%",
                transform: `translate(-50%, -50%) scale(${beat === 1 ? 1 : 0.35})`,
                transition: `left 340ms var(--ease-arrive) ${i * 80}ms, top 340ms var(--ease-arrive) ${i * 80}ms, transform 340ms var(--ease-arrive) ${i * 80}ms`,
              }}
            >
              <span
                className="block h-full w-full rounded-lg"
                style={{
                  background: "var(--color-magenta)",
                  backgroundImage:
                    "radial-gradient(circle, rgba(11,6,32,.55) 1px, transparent 1.2px)",
                  backgroundSize: "5px 5px",
                  animation:
                    beat === 1 ? `orbit 3s linear ${420 + i * 80}ms infinite` : "none",
                }}
              />
            </span>
          ))}
        </div>

        {/* ---------------------------------------------------- beat 2 */}
        {/* A signed decision pops out and the fill prints publicly. */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 transition-opacity duration-300"
          style={{ opacity: beat === 2 ? 1 : 0 }}
          aria-hidden
        >
          <div
            className="flex items-center gap-2.5 rounded-2xl border-[3px] px-5 py-3"
            style={{
              borderColor: "var(--color-lime)",
              background: "color-mix(in srgb, var(--color-lime) 14%, transparent)",
              transform: beat === 2 ? "scale(1)" : "scale(.85)",
              transition: "transform 380ms var(--ease-pop)",
            }}
          >
            <span className="mono text-[11px] tracking-[0.14em] text-[var(--color-lime)]">
              SIGNED
            </span>
            <span className="text-[26px] font-extrabold text-[var(--color-text)]">
              BUY
            </span>
          </div>
          {/* The checks that actually gate a fill. This beat used to be one
              pill and one price on a large stage, which said "a decision came
              out" and nothing about what had to be true first — and that gate
              is most of what the program is. Every row here is a real check in
              the deployed program; see the guardrails table on /app/strategy. */}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            {["oracle 4s old", "size 10% ≤ cap", "slippage ≤ 0.5%"].map((c) => (
              <span
                key={c}
                className="mono text-[10px] tracking-[0.08em] text-[var(--color-text-3)]"
              >
                <span style={{ color: "var(--color-lime)" }}>✓</span> {c}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="chip chip-cyan">ON CHAIN</span>
            <span className="mono tnum text-[13px] text-[var(--color-cyan)]">
              {price === null ? "—" : `${(price * 0.96).toFixed(2)} USDC`}
            </span>
          </div>
        </div>

        {/* The beat pips, bottom-left. Also the tap targets under reduced
            motion, where the loop does not advance on its own. */}
        <div className="absolute bottom-3 left-4 flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <button
              key={i}
              onClick={() => setBeat(i)}
              aria-label={`Show step ${i + 1}`}
              className="h-1.5 rounded-full transition-all duration-300"
              style={{
                width: i === beat ? 22 : 8,
                background: i === beat ? "var(--color-lime)" : "var(--color-stroke)",
              }}
            />
          ))}
        </div>
      </div>

      {/* The caption swaps one line per beat — this is what makes the loop
          narrate itself instead of needing a paragraph beside it. */}
      <div className="mt-4 min-h-[52px]">
        <p key={beat} className="pop text-[var(--text-body)] font-semibold">
          {BEATS[beat].caption}
        </p>
        <p className="mono mt-1 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-3)]">
          {BEATS[beat].detail}
        </p>
      </div>

      {/* Never swaps. The one sentence that must survive every beat. */}
      <p className="mono mt-3 text-[11px] uppercase tracking-[0.1em] text-[var(--color-amber)]">
        The trade is public on Solana. The three prices are not.
      </p>
    </div>
  );
}

function Lock() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.5"
        stroke="var(--color-void)"
        strokeWidth="2"
      />
      <path
        d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
        stroke="var(--color-void)"
        strokeWidth="2"
      />
    </svg>
  );
}
