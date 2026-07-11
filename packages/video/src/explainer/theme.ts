// Shared constants + tokens for the Explainer family. Colors come from
// @fluncle/tokens (the DESIGN.md mirror); the three canon faces embed themselves
// on import of fonts.ts.

import { colors } from "@fluncle/tokens";

import { MONO_STACK, OXANIUM_STACK, SPACE_GROTESK_STACK } from "../remotion/fonts";

import { type ChapterAccent } from "./types";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** The star-warp seam between chapters. */
export const TRANSITION_MS = 900;
/** How long the chapter card holds before the content shows through. */
export const CARD_MS = 1_100;
/** Broadcast-safe margin from the frame edge. */
export const SAFE = 96;
/** Clear gutter kept between the captions and the picture-in-picture cam. */
export const PIP_GAP = 40;

export const msToFrames = (ms: number, fps = FPS) => Math.round((ms / 1000) * fps);

// The picture-in-picture cam scales with the frame width so it stays a corner
// cam on portrait/square, not a face that eats a third of a 1080-wide frame.
// 16:9 → 480×300 (unchanged); 9:16 (1080w) → 324×203; 1:1 (1080w) → 324×203.
export const pipWidth = (frameWidth: number) => Math.min(480, Math.round(frameWidth * 0.3));
export const pipHeight = (frameWidth: number) => Math.round(pipWidth(frameWidth) * 0.625);
/** How much horizontal room a bottom-right PiP steals from a centered caption. */
export const captionReserveRight = (frameWidth: number) => SAFE + pipWidth(frameWidth) + PIP_GAP;

// The three canon roles (DESIGN.md §3). `display` is the brand voice: marks,
// mastheads, and every numeral/coordinate/date. `body` carries all reading text,
// titles and labels (max weight 700 — its axis stops there). `mono` is the
// machine's own voice and speaks ONLY on terminal surfaces: literal commands,
// code, ASCII terminal output.
export const font = {
  body: SPACE_GROTESK_STACK,
  display: OXANIUM_STACK,
  mono: MONO_STACK,
};

/** A coordinate is the brand's numeral, everywhere it appears — Oxanium, tabular
 *  (DESIGN.md's Tabular Rule), even inside a `fluncle://` URI. Spread this. */
export const coordType = {
  fontFamily: OXANIUM_STACK,
  fontVariantNumeric: "tabular-nums",
} as const;

// Re-export tokens under a short alias so component code stays terse.
export const c = colors;

export const accentColor = (accent: ChapterAccent = "gold"): string => {
  if (accent === "violet") {
    return colors.nebulaViolet;
  }
  if (accent === "red") {
    return colors.reentryRed;
  }
  return colors.eclipseGold;
};
