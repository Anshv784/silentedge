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
    let rx = -999;
    let ry = -999;
    let running = false;
    let idle = 0;

    const frame = () => {
      // Exponential smoothing. The ring is roughly three times as eager as the
      // light, which is what makes them separate under speed.
      lx += (tx - lx) * 0.12;
      ly += (ty - ly) * 0.12;
      rx += (tx - rx) * 0.34;
      ry += (ty - ry) * 0.34;

      l.style.setProperty("--mx", `${lx}px`);
      l.style.setProperty("--my", `${ly}px`);
      r.style.setProperty("--rx2", `${rx}px`);
      r.style.setProperty("--ry2", `${ry}px`);

      // Stop the loop once everything has settled. An always-on rAF is a
      // battery cost for nothing.
      const settled =
        Math.abs(tx - lx) < 0.4 &&
        Math.abs(ty - ly) < 0.4 &&
        Math.abs(tx - rx) < 0.4 &&
        Math.abs(ty - ry) < 0.4;
      if (settled && ++idle > 4) {
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
