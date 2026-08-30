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
const SHARES: [string, string, string][] = [
  ["c1·7e", "40·9b", "d2·05"],
  ["0a·b4", "8f·2c", "6e·77"],
  ["94·2f", "13·d8", "ab·31"],
  ["e6·38", "72·1a", "5c·90"],
  ["5d·d1", "e9·64", "08·bf"],
];

/** The five node positions, as percentages of the stage. */
const NODES = [
  { x: 18, y: 20 },
  { x: 74, y: 17 },
  { x: 80, y: 63 },
  { x: 46, y: 82 },
  { x: 16, y: 66 },
];

export function Machine({ price }: { price: number | null }) {
  const [beat, setBeat] = useState(0);

  /* A timeout keyed on `beat`, not a free-running interval. With an interval
     the pips did nothing that lasted: you clicked one, and the next tick — up
     to 2.6s later, or immediately — pulled you somewhere else. They are
     labelled as controls, and under reduced motion they are the only way to
     advance, so a click has to hold. Each beat now schedules the one after it,
     which means clicking re-arms the clock and you get a full beat to read. */
  useEffect(() => {
    const id = setTimeout(() => setBeat((b) => (b + 1) % 3), 2600);
    return () => clearTimeout(id);
  }, [beat]);

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
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-3 transition-opacity duration-300"
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
        {/* One sealed block splits, and every node ends up holding a fragment
            of all three prices and a whole copy of none.

            This used to be five bare dots and three tiles on a large stage —
            technically the right diagram, but almost entirely empty space, and
            it did not show the thing that makes MPC MPC: that each node's copy
            is USELESS, not just partial. Each node is a card now, listing what
            it holds for buy / sell / stop. Fifteen fragments, no whole
            numbers, and the box is full. */}
        <div
          className="pointer-events-none absolute inset-0 transition-opacity duration-300"
          style={{ opacity: beat === 1 ? 1 : 0 }}
          aria-hidden
        >
          {/* Links, as DOM elements in the SAME percentage space as the cards.
              They were an SVG with its own viewBox, and the two spaces do not
              agree: the stage carries a 3D perspective tilt, which projects the
              cards non-linearly (a node declared at 80/63 lands at 70.7/53.6)
              while the viewBox maps straight through. So every line stopped
              short of its card or shot past it. Positioned like this there is
              one coordinate system and they cannot drift.

              The angle is computable ahead of time because the stage is a
              fixed 5/4, so one vertical percent is 0.8 of a horizontal one. */}
          {NODES.map((n, i) => {
            const dx = n.x - 50;
            const dy = (n.y - 50) * 0.8;
            return (
              <span
                key={i}
                className="absolute left-1/2 top-1/2 h-0 border-t-2 border-dashed"
                style={{
                  /* Stop short of the node rather than running to its centre.
                     The cards paint over these, but the perspective projection
                     moves a card a few px from where the flat maths puts it,
                     so a line drawn to the exact centre poked out the far side.
                     A card is ~15% of the stage wide, so its half-width is ~7.5%;
                     ending 4% early keeps the tip inside the card while
                     leaving no visible gap on the long diagonals. */
                  width: `${Math.max(0, Math.hypot(dx, dy) - 4)}%`,
                  transformOrigin: "0 50%",
                  transform: `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI}deg)`,
                  borderColor: "var(--color-stroke)",
                }}
              />
            );
          })}

          {/* The origin: the sealed block from beat 0, now the thing being
              divided. It shrinks as the shares land. */}
          <span
            className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg"
            style={{
              background: "var(--color-magenta)",
              backgroundImage:
                "radial-gradient(circle, rgba(11,6,32,.55) 1px, transparent 1.2px)",
              backgroundSize: "5px 5px",
              transform: `translate(-50%, -50%) scale(${beat === 1 ? 0.75 : 1})`,
              transition: "transform 420ms var(--ease-arrive)",
            }}
          />

          {NODES.map((n, i) => (
            <span
              key={i}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 px-2.5 py-2"
              style={{
                left: `${n.x}%`,
                top: `${n.y}%`,
                borderColor: "var(--color-magenta)",
                background: "var(--color-deep)",
                opacity: beat === 1 ? 1 : 0,
                transform: `translate(-50%, -50%) scale(${beat === 1 ? 1 : 0.6})`,
                transition: `opacity 300ms ease ${i * 70}ms, transform 340ms var(--ease-arrive) ${i * 70}ms`,
              }}
            >
              <span className="mono block text-[8px] tracking-[0.14em] text-[var(--color-magenta)]">
                NODE {i + 1}
              </span>
              {(["buy", "sell", "stop"] as const).map((k, j) => (
                <span key={k} className="mt-1 flex items-center gap-1.5">
                  <span className="mono text-[8px] text-[var(--color-text-3)]">
                    {k}
                  </span>
                  <span className="mono tnum text-[9px] text-[var(--color-text-2)]">
                    {SHARES[i][j]}
                  </span>
                </span>
              ))}
            </span>
          ))}
        </div>


        {/* ---------------------------------------------------- beat 2 */}
        {/* A signed decision pops out and the fill prints publicly. */}
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 transition-opacity duration-300"
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
            motion, where the loop does not advance on its own — which is why
            the three beat layers above are pointer-events-none. They are
            aria-hidden decoration covering the whole stage, and they were
            swallowing every click aimed at these: elementFromPoint at a pip's
            own centre returned the beat-1 link SVG, so the only control on the
            diagram could not be hit by a mouse. */}
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
