"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Scale factor (≤ 1) that makes `inner` fit inside `outer`'s height, so a
 * fixed composition (the landing hero) never needs a scroll on short screens.
 * Uses transform-free offsetHeight, so the transform itself doesn't feed back.
 *
 * The width does feed back: the caller lays `inner` out 1/scale wider, so a smaller scale lets a line
 * unwrap (the headline goes from two lines to one), `inner` gets a whole line shorter, the next
 * measure asks for a bigger scale, the line wraps again, and the page flips between the two layouts
 * every frame. So the scale may only grow when `outer` changes size (window resize) or the fonts
 * finish loading. A change in `inner` alone (our own re-wrap, the stats counting up) may only shrink
 * it. Shrinking always fits, so it settles in at most one step back.
 */
export function useFitHeight(outer: RefObject<HTMLElement | null>, inner: RefObject<HTMLElement | null>, minScale = 0.6) {
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    let alive = true;
    const measure = (mayGrow: boolean) => {
      const natural = i.offsetHeight;
      if (!natural) return;
      const next = Math.max(minScale, Math.min(1, o.clientHeight / natural));
      setScale((prev) => {
        if (Math.abs(prev - next) < 0.003) return prev; // sub-pixel nudges
        if (next > prev && !mayGrow) return prev; // growth caused by our own re-wrap: would loop
        return next;
      });
    };
    measure(true);
    const ro = new ResizeObserver((entries) => measure(entries.some((e) => e.target === o)));
    ro.observe(o);
    ro.observe(i);
    // Web fonts can arrive after the first measure and make the text shorter; let the scale grow once for that.
    document.fonts?.ready.then(() => alive && measure(true));
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [outer, inner, minScale]);

  return scale;
}
