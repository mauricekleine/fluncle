// Oxanium is the brand voice (DESIGN.md: numerals, marks, brand moments).
// Loaded from local woff2 files in public/fonts via @remotion/fonts so renders
// never touch the network. loadFont blocks the render until the font is ready.
//
// Two subsets ship: latin and latin-ext. Both register under the same family
// name ("Oxanium") so unicode-range fallback resolves automatically. The files
// are byte-identical to the apps/web copies.
//
// Determinism note: loadFont is a side effect run at module load, not inside a
// composition, so it does not break frame-determinism.

import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

/** The font family name to reference in `fontFamily`. */
export const OXANIUM = "Oxanium" as const;

/** Oxanium stack mirroring DESIGN.md's display/numeric roles. */
export const OXANIUM_STACK = "Oxanium, ui-sans-serif, system-ui, sans-serif" as const;

let loadPromise: Promise<void> | null = null;

/**
 * Loads both Oxanium subsets once and returns the combined promise. Safe to call
 * many times (memoized). Remotion blocks the render on the returned promise via
 * delayRender internally, so callers can fire-and-forget at module scope.
 */
export const loadOxanium = (): Promise<void> => {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = Promise.all([
    loadFont({
      family: OXANIUM,
      format: "woff2",
      url: staticFile("fonts/oxanium-latin.woff2"),
      weight: "400 800",
    }),
    loadFont({
      family: OXANIUM,
      format: "woff2",
      url: staticFile("fonts/oxanium-latin-ext.woff2"),
      weight: "400 800",
    }),
  ]).then(() => undefined);

  return loadPromise;
};

// Eagerly start loading at import so the font is ready by first paint.
void loadOxanium();
