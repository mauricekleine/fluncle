// Oxanium is the brand voice (DESIGN.md: numerals, marks, brand moments).
// Loaded from local woff2 files in public/fonts (the FontFace API) so renders
// never touch the network, under a delayRender handle that blocks the render
// until the font is ready.
//
// Two subsets ship: latin and latin-ext. Both register under the same family
// name ("Oxanium") so unicode-range fallback resolves automatically. The files
// are byte-identical to the apps/web copies.
//
// Determinism note: the load is a side effect run at module load, not inside a
// composition, so it does not break frame-determinism.

import { continueRender, delayRender, staticFile } from "remotion";

/** The font family name to reference in `fontFamily`. */
export const OXANIUM = "Oxanium" as const;

/** Oxanium stack mirroring DESIGN.md's display/numeric roles. */
export const OXANIUM_STACK = "Oxanium, ui-sans-serif, system-ui, sans-serif" as const;

let loadPromise: Promise<void> | null = null;

/**
 * Loads both Oxanium subsets once and returns the combined promise. Safe to call
 * many times (memoized). We hold a delayRender handle for the duration so the
 * render blocks until the font is ready; callers fire-and-forget at module scope.
 */
export const loadOxanium = (): Promise<void> => {
  if (loadPromise) {
    return loadPromise;
  }

  // Browser-only: a non-DOM context (SSR bundling) has nothing to load.
  if (typeof document === "undefined" || typeof FontFace === "undefined") {
    loadPromise = Promise.resolve();
    return loadPromise;
  }

  // Load both subsets under a delayRender handle we OWN and ALWAYS clear (finally),
  // rather than @remotion/fonts' loadFont — whose internal delayRender is not cleared
  // when the total render wall-time exceeds the timeout window (a slow software-GL
  // render on a GPU-less host), tripping a spurious timeout even though the font
  // loaded fine (remotion #5843). The handle's lifetime is bound to the actual load.
  loadPromise = (async () => {
    const handle = delayRender(`Loading ${OXANIUM}`);
    try {
      const faces = await Promise.all(
        ["fonts/oxanium-latin.woff2", "fonts/oxanium-latin-ext.woff2"].map((file) =>
          new FontFace(OXANIUM, `url(${staticFile(file)}) format("woff2")`, {
            weight: "400 800",
          }).load(),
        ),
      );
      for (const face of faces) {
        document.fonts.add(face);
      }
    } finally {
      continueRender(handle);
    }
  })();

  return loadPromise;
};

// Eagerly start loading at import so the font is ready by first paint.
void loadOxanium();
