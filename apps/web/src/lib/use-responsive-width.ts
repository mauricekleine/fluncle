// Pick a Media Transformations rendition width that matches the pane a footage
// clip actually paints into, instead of always pulling the 1080-wide master.
//
// A footage element rendered ~390 CSS px wide on a 3× phone wants ~720 device
// px, not 1080 — and a small log-page thumbnail wants less still. We measure
// the element with a ResizeObserver, multiply by devicePixelRatio (capped, so a
// 3× display doesn't demand a 4K transcode of a phone-sized pane), then snap UP
// to the nearest rung on the rendition ladder. Snapping keeps the number of
// distinct (separately-cached) transforms small; rounding up never serves a
// blurrier rendition than the pane needs.
//
// Returns `undefined` until the element is measured AND on the server, so the
// caller can hold NO source at all for SSR/first paint — the poster holds the
// pane — and attach the rendition once a real width is known (never a
// speculative master request that gets aborted a tick later).
//
// The ladder is also the recovery path: when a load WEDGES (the stall watchdog),
// the caller steps the requested rung DOWN with `stepDownRenditionWidth` — fewer
// bytes for a link that could not carry the last request. Same ladder, one
// mechanism, walked in both directions.

import { type RefObject, useEffect, useState } from "react";
import { type RenditionWidth } from "./media";

// Ascending; `pickRenditionWidth` snaps up to the first rung that covers the
// measured device width (and clamps to the widest = the master's own width).
export const RENDITION_LADDER: readonly RenditionWidth[] = [360, 480, 720, 1080];

/** The lightest rung: the floor a stall step-down (`stepDownRenditionWidth`) walks to. */
export const SMALLEST_RENDITION_WIDTH: RenditionWidth = 360;

// Beyond 2× the extra resolution is invisible at arm's length but doubles the
// bytes; cap the multiplier so a 3× phone tops out at the 720 rung, not 1080.
const MAX_PIXEL_RATIO = 2;

/** Snap a device-pixel width up to the nearest rendition rung. */
function pickRenditionWidth(deviceWidth: number): RenditionWidth {
  for (const rung of RENDITION_LADDER) {
    if (deviceWidth <= rung) {
      return rung;
    }
  }

  // The ladder is a non-empty const, so the last rung always exists; the
  // widest rung (1080) is the safe fallback if that invariant ever changes.
  return RENDITION_LADDER[RENDITION_LADDER.length - 1] ?? 1080;
}

/**
 * Walk `steps` rungs DOWN the ladder from `width`, clamped at the lightest rung.
 *
 * The pane-sized rung is the right FIRST request, but a link too thin to carry it
 * stalls — and a stall is a bytes problem, so the answer is fewer bytes, not more.
 * The stall watchdog steps the requested rendition down a rung per wedge (720 →
 * 480 → 360) instead of bailing UP to the raw master, which is strictly heavier
 * than any rendition and cannot help a starved connection. A slightly soft clip
 * that plays beats a crisp one that never starts.
 *
 * Pure and total: 0 steps is the identity, and stepping past the floor pins to it
 * (`SMALLEST_RENDITION_WIDTH`), so a caller can count wedges without bounds-checking.
 */
export function stepDownRenditionWidth(width: RenditionWidth, steps: number): RenditionWidth {
  const index = RENDITION_LADDER.indexOf(width);

  if (index < 0) {
    return width;
  }

  const target = Math.max(0, index - Math.max(0, Math.trunc(steps)));

  return RENDITION_LADDER[target] ?? SMALLEST_RENDITION_WIDTH;
}

/**
 * Observe `ref`'s rendered width and return the rendition rung it needs.
 *
 * `undefined` until measured (and always on the server), so callers attach no
 * source for first paint (the poster holds the pane) and swap in the rendition
 * once a width is known.
 */
export function useResponsiveWidth(ref: RefObject<HTMLElement | null>): RenditionWidth | undefined {
  const [width, setWidth] = useState<RenditionWidth | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;

    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

    const measure = () => {
      const cssWidth = element.getBoundingClientRect().width;

      if (cssWidth > 0) {
        setWidth(pickRenditionWidth(cssWidth * ratio));
      }
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, [ref]);

  return width;
}
