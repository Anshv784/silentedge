"use client";

import { useEffect, useRef } from "react";

/**
 * The cursor light and ring.
 *
 * Two elements follow the pointer at different speeds. The light is a large
 * soft radial that lags well behind, so it reads as a lamp being carried across
 * the grid rather than a dot glued to the arrow. The ring is tighter and
 * catches up quickly, so the two separate on a fast flick and rejoin when the
 * hand stops — which is the whole effect.
 *
 * Cost, because this is the kind of thing that quietly ruins a page:
 *
 *   - ONE `pointermove` listener, passive, which does nothing but store two
 *     numbers. No layout is read in it.
 *   - ONE rAF loop, and it exits itself when the pointer has been still, so an
 *     idle tab is not animating anything.
 *   - Both elements move by writing custom properties consumed by a
 *     `translate3d`, so this is a compositor transform and never a repaint.
 *   - Nothing here is React state, so the page never re-renders because the
 *     mouse moved.
 *
 * It is not rendered at all on touch devices or under reduced motion — see the
 * media queries in globals.css — and the real cursor is never hidden. A site
 * that replaces your cursor with a laggy circle is a site you cannot use.
 */
export function Cursor() {
  const light = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const l = light.current;
    const r = ring.current;
    if (!l || !r) return;

    // target, light position, ring position
    let tx = -999;
    let ty = -999;
    let lx = -999;
    let ly = -999;
    let running = false;
    let idle = 0;

    const frame = () => {
      /* The light drifts; the ring does not.
         Both used to be smoothed — the light at 0.12 and the ring at 0.34,
         which is ~300ms and ~90ms to converge. Perceptible cursor lag starts
         around 50ms, so the ring sat past the threshold and the whole PAGE read
         as slow even at a clean 60fps. Frame times were never the problem; the
         lag was designed in.

         The ring now tracks the pointer exactly, so nothing near the cursor
         ever trails it. Only the large ambient light drifts, at a rate fast
         enough to feel attached rather than dragged. */
      lx += (tx - lx) * 0.38;
      ly += (ty - ly) * 0.38;

      l.style.setProperty("--mx", `${lx}px`);
      l.style.setProperty("--my", `${ly}px`);

      // Stop the loop once the light has caught up. An always-on rAF is a
      // battery cost for nothing.
      const settled = Math.abs(tx - lx) < 0.5 && Math.abs(ty - ly) < 0.5;
      if (settled && ++idle > 2) {
        running = false;
        return;
      }
      if (!settled) idle = 0;
      requestAnimationFrame(frame);
    };

    const kick = () => {
      if (running) return;
      running = true;
      idle = 0;
      requestAnimationFrame(frame);
    };

    const move = (e: PointerEvent) => {
      tx = e.clientX;
      ty = e.clientY;
      // The ring is written straight from the event — no smoothing, no waiting
      // for a frame. This is the element the eye treats as the cursor.
      r.style.setProperty("--rx2", `${tx}px`);
      r.style.setProperty("--ry2", `${ty}px`);
      l.dataset.on = "1";
      r.dataset.on = "1";
      kick();
    };

    /* Whether the pointer is over something you can act on. `closest` on the
       event target is cheap and runs only on move, not per frame. */
    const over = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      const hot = !!el?.closest?.("a,button,input,label,[role='button']");
      r.dataset.hot = hot ? "1" : "0";
      r.style.setProperty("--rs", hot ? "1.9" : "1");
    };

    const leave = () => {
      l.dataset.on = "0";
      r.dataset.on = "0";
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerover", over, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerover", over);
      document.removeEventListener("pointerleave", leave);
      running = false;
    };
  }, []);

  return (
    <>
      <div ref={light} className="cursor-light" aria-hidden />
      <div ref={ring} className="cursor-ring" aria-hidden />
    </>
  );
}
