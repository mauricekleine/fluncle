// The brand's two text faces, embedded for the render (DESIGN.md §3).
//
// Oxanium is the DISPLAY face: brand marks, plate mastheads, and every numeral /
// coordinate / date. Space Grotesk is the BODY face: reading text, titles, labels.
// Its variable axis stops at 700 — asking for 800 clamps silently, so no body role
// may ask for it.
//
// THE CANON TRAVELS RULE (DESIGN.md §3). A render environment has no system fonts
// to inherit and no stylesheet to cascade from, so it must EMBED the faces itself.
// This package used to embed Oxanium ONLY, and the /galaxy OG card's tagline fell
// through to a bare `sans-serif` — which resolves to Helvetica on a Mac and DejaVu
// Sans on a Linux render box. The same committed asset rendered in two different
// typefaces depending on where it was built: exactly the "three renderings, only one
// of which we ever looked at" bug the canon exists to kill. Both faces ship now.
//
// THE ONE BOX RULE (DESIGN.md §3). Both faces are re-cut to the SAME 1.25em metric
// box via ascent/descent/line-gap overrides, so that (ascent − descent) equals that
// face's cap height and the cap band lands on the box centre. That is what makes a
// plain `align-items: center` optically centre Oxanium and Space Grotesk together —
// the brand mark and the tagline on one centre line, at any size. These numbers are
// ratified and byte-for-byte the ones in apps/web/src/styles.css; they are
// LOAD-BEARING — do not drop or re-derive them when updating a font.
//
// Two subsets per face (latin + latin-ext) register under one family name, split by
// unicodeRange exactly as the web declares them, so glyph coverage resolves the same
// way here as it does in the browser. The woff2 files under public/fonts are
// byte-identical to the apps/web copies.
//
// WHY loadFont IS SAFE HERE (and is NOT in packages/video). loadFont calls
// `new FontFace().load()`, and that Promise NEVER SETTLES under the `swangle`
// software-GL renderer — it would block the render forever via delayRender. That is
// why packages/video embeds its fonts as base64 @font-face CSS instead. This package
// gets to use loadFont because every one of its render paths hardcodes ANGLE:
// remotion.config.ts (`setChromiumOpenGlRenderer("angle")`) covers Studio and the
// CLI, and all three render scripts pass `chromiumOptions: { gl: "angle" }` to both
// selectComposition and renderStill. There is deliberately NO FLUNCLE_GL escape hatch
// here. IF YOU EVER ADD A SOFTWARE-GL PATH TO THIS PACKAGE (a GPU-less box render),
// THIS FILE MUST MOVE TO THE BASE64 PATTERN IN packages/video/src/remotion/fonts.ts
// FIRST — otherwise the render hangs rather than fails.
//
// Failure is loud by construction: loadFont wraps the load in delayRender and calls
// cancelRender on error, so a missing or corrupt font FAILS the render instead of
// silently falling back to the system sans. That silent fallback is the bug.
//
// Determinism note: loadFont is a side effect run at module load, not inside a
// composition, so it does not break frame-determinism.

import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

/** The display family name to reference in `fontFamily`. */
export const OXANIUM = "Oxanium" as const;

/** The body family name to reference in `fontFamily`. */
export const SPACE_GROTESK = "Space Grotesk" as const;

/** Oxanium stack — DESIGN.md's display/numeric roles (brand marks, coordinates). */
export const OXANIUM_STACK = "Oxanium, ui-sans-serif, system-ui, sans-serif" as const;

/** Space Grotesk stack — DESIGN.md's body roles (reading text, titles, labels). */
export const SPACE_GROTESK_STACK = "Space Grotesk, ui-sans-serif, system-ui, sans-serif" as const;

/** The One Box overrides for Oxanium (DESIGN.md §3; mirrors apps/web/src/styles.css). */
const OXANIUM_BOX = {
  ascentOverride: "97%",
  descentOverride: "28%",
  lineGapOverride: "0%",
  weight: "200 800",
} as const;

/** The One Box overrides for Space Grotesk. 700 is the axis ceiling, never 800. */
const SPACE_GROTESK_BOX = {
  ascentOverride: "97.5%",
  descentOverride: "27.5%",
  lineGapOverride: "0%",
  weight: "300 700",
} as const;

/** The latin subset's coverage, as declared in apps/web/src/styles.css. */
const LATIN_RANGE =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

/** The latin-ext subset's coverage, as declared in apps/web/src/styles.css. */
const LATIN_EXT_RANGE =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

let loadPromise: Promise<void> | null = null;

/**
 * Loads both subsets of BOTH brand faces once and returns the combined promise.
 * Safe to call many times (memoized). Remotion blocks the render on each load via
 * delayRender internally, so callers can fire-and-forget at module scope.
 */
export const loadBrandFonts = (): Promise<void> => {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = Promise.all([
    loadFont({
      ...OXANIUM_BOX,
      family: OXANIUM,
      format: "woff2",
      unicodeRange: LATIN_RANGE,
      url: staticFile("fonts/oxanium-latin.woff2"),
    }),
    loadFont({
      ...OXANIUM_BOX,
      family: OXANIUM,
      format: "woff2",
      unicodeRange: LATIN_EXT_RANGE,
      url: staticFile("fonts/oxanium-latin-ext.woff2"),
    }),
    loadFont({
      ...SPACE_GROTESK_BOX,
      family: SPACE_GROTESK,
      format: "woff2",
      unicodeRange: LATIN_RANGE,
      url: staticFile("fonts/space-grotesk-latin.woff2"),
    }),
    loadFont({
      ...SPACE_GROTESK_BOX,
      family: SPACE_GROTESK,
      format: "woff2",
      unicodeRange: LATIN_EXT_RANGE,
      url: staticFile("fonts/space-grotesk-latin-ext.woff2"),
    }),
  ]).then(() => undefined);

  return loadPromise;
};

// Eagerly start loading at import so both faces are ready by first paint.
void loadBrandFonts();
