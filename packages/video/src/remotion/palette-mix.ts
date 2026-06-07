import { colors } from "@fluncle/tokens";
import { type CosmosPalette } from "./types";
import { luminance, mix, saturation, warmth } from "./color";

export type PaletteMixOptions = {
  /**
   * How far the background is allowed to drift from Deep Field toward the
   * artwork's darkest swatch. Kept small: the Warm Dark Rule says the night sky
   * stays a warm near-black. 0..1, default 0.18.
   */
  backgroundDrift?: number;
  /**
   * Warmth threshold above which the artwork is "warm enough" to let the accent
   * lean to Eclipse Gold. Default 0.12.
   */
  warmThreshold?: number;
};

/**
 * Blends artwork swatches toward the brand anchors to produce the composition
 * palette (CosmosPalette).
 *
 * Brand rules encoded here (DESIGN.md):
 * - The One Sun Rule: Eclipse Gold is the single light source. `glow` is always
 *   gold-family, reserved for the one-sun moment. We never hand the artwork the
 *   gold; we reserve it.
 * - The Warm Dark Rule: `background` stays a warm near-black, only nudged toward
 *   the artwork's darkest swatch.
 * - Accent: if the artwork reads warm, bias the accent toward Eclipse Gold so the
 *   piece feels lit by the same sun. If it reads cool, keep the artwork's own
 *   most-chromatic swatch as accent (the sun stays reserved for `glow`).
 *
 * Pure and deterministic. Falls back to the full brand palette when no swatches
 * are supplied, so placeholder props still render on-brand.
 */
export const paletteMix = (swatches: string[], options: PaletteMixOptions = {}): CosmosPalette => {
  const backgroundDrift = options.backgroundDrift ?? 0.18;
  const warmThreshold = options.warmThreshold ?? 0.12;

  const clean = swatches.filter((s) => typeof s === "string" && s.trim().length > 0);

  if (clean.length === 0) {
    return {
      accent: colors.eclipseGold,
      background: colors.deepField,
      glow: colors.eclipseGlow,
      ink: colors.starlightCream,
      swatches: [colors.eclipseGold, colors.eclipseGlow, colors.reentryRed],
    };
  }

  const sorted = [...clean].sort((a, b) => luminance(a) - luminance(b));
  const darkest = sorted[0]!;
  const brightest = sorted[sorted.length - 1]!;

  // Most chromatic swatch is the artwork's natural accent candidate.
  const mostChromatic = [...clean].sort((a, b) => saturation(b) - saturation(a))[0]!;

  // Background: warm near-black, gently drifted toward the artwork's darkest.
  const background = mix(colors.deepField, darkest, backgroundDrift);

  // Average warmth across swatches decides the accent strategy.
  const avgWarmth = clean.reduce((sum, s) => sum + warmth(s), 0) / clean.length;
  const accent =
    avgWarmth >= warmThreshold
      ? // Warm artwork: lean the chromatic swatch toward Eclipse Gold.
        mix(mostChromatic, colors.eclipseGold, 0.55)
      : // Cool artwork: keep the artwork's own accent; reserve gold for the sun.
        mostChromatic;

  // Ink: keep Starlight Cream legible; lift slightly toward the brightest swatch
  // so the type feels of-a-piece without losing the aged-paper cream.
  const ink = mix(colors.starlightCream, brightest, 0.12);

  // Glow stays gold-family always: the reserved one-sun light.
  const glow = colors.eclipseGlow;

  return {
    accent,
    background,
    glow,
    ink,
    swatches: clean,
  };
};
