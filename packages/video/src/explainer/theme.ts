import { colors } from "@fluncle/tokens";

import { MONO_STACK, OXANIUM_STACK, SPACE_GROTESK_STACK } from "../remotion/fonts";

import { type ChapterAccent } from "./types";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const TRANSITION_MS = 900;

export const CARD_MS = 1_100;

export const SAFE = 96;

export const PIP_GAP = 40;

export const msToFrames = (ms: number, fps = FPS) => Math.round((ms / 1000) * fps);

export const pipWidth = (frameWidth: number) => Math.min(480, Math.round(frameWidth * 0.3));
export const pipHeight = (frameWidth: number) => Math.round(pipWidth(frameWidth) * 0.625);

export const captionReserveRight = (frameWidth: number) => SAFE + pipWidth(frameWidth) + PIP_GAP;

export const font = {
  body: SPACE_GROTESK_STACK,
  display: OXANIUM_STACK,
  mono: MONO_STACK,
};

export const coordType = {
  fontFamily: OXANIUM_STACK,
  fontVariantNumeric: "tabular-nums",
} as const;

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
