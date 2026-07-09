// Shared constants + tokens for the Explainer family. Colors come from
// @fluncle/tokens (the DESIGN.md mirror); Oxanium loads on import of fonts.ts.

import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "../remotion/fonts";

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

export const msToFrames = (ms: number, fps = FPS) => Math.round((ms / 1000) * fps);

export const font = {
  body: "ui-sans-serif, system-ui, sans-serif",
  display: OXANIUM_STACK,
  mono: "ui-monospace, SF Mono, Menlo, monospace",
};

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
