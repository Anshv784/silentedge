"use client";

import { useEffect, useRef } from "react";

/**
 * The cursor light.
 *
 * A large soft radial that follows the pointer, so moving the mouse lights the
 * grid underneath it. That is the whole effect now.
 *
 * There was a ring drawn around the cursor as well. It is gone: a second thing
 * orbiting your pointer is decoration competing with the arrow you are actually
 * aiming with, and it made the page feel heavy even after it tracked exactly.
 * The light works because it is ambient — it is nowhere near precise enough for
 * the eye to catch it lagging.
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

  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const l = light.current;
    if (!l) return;

    // target, light position, ring position
    let tx = -999;
    let ty = -999;
    let lx = -999;
    let ly = -999;
    let running = false;
    let idle = 0;

    const frame = () => {
      /* Smoothed at 0.38 — about 80ms to converge. Slow enough to read as a
         light being carried, fast enough that it never reads as lag. The
         earlier 0.12 was ~300ms and was the reason the page felt slow. */
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
      l.dataset.on = "1";
      kick();
    };


    const leave = () => {
      l.dataset.on = "0";
    };

    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
      running = false;
    };
  }, []);

  return <div ref={light} className="cursor-light" aria-hidden />;
}
