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
// caller can hold the raw master for SSR/first paint and swap to the rendition
// once a real width is known (no layout-shift, no guessing on the server).

import { type RefObject, useEffect, useState } from "react";
import { type RenditionWidth } from "./media";

// Ascending; `pickRenditionWidth` snaps up to the first rung that covers the
// measured device width (and clamps to the widest = the master's own width).
const RENDITION_LADDER: readonly RenditionWidth[] = [360, 480, 720, 1080];

// Beyond 2× the extra resolution is invisible at arm's length but doubles the
// bytes; cap the multiplier so a 3× phone tops out at the 720 rung, not 1080.
const MAX_PIXEL_RATIO = 2;

/** Snap a device-pixel width up to the nearest rendition rung. */
export function pickRenditionWidth(deviceWidth: number): RenditionWidth {
  for (const rung of RENDITION_LADDER) {
    if (deviceWidth <= rung) {
      return rung;
    }
  }

  return RENDITION_LADDER[RENDITION_LADDER.length - 1];
}

/**
 * Observe `ref`'s rendered width and return the rendition rung it needs.
 *
 * `undefined` until measured (and always on the server), so callers keep the
 * raw master for first paint and swap to the rendition once a width is known.
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
