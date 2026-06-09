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
 * - Accent: always gold-family. The Retint Rule applies to palettes too — the
 *   artwork's most-chromatic swatch flavors the accent, but it is always leaned
 *   toward Eclipse Gold, and the cooler the artwork reads, the harder the lean.
 *   A cold sleeve never gets to extinguish the sun (the Loadstar incident).
 *   NOTE: `accent` (and `glow`) are LIGHT MATERIAL for the vehicle/shaders —
 *   never type ink. Type takes `ink` or a scene-derived swatch (doctrine 4:
 *   gold is the sun, never the type).
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

  // Average warmth across swatches decides how hard the accent leans gold:
  // warm artwork keeps more of its own character, cool artwork gets pulled
  // firmly into the sun's family so the accent can never read cold.
  const avgWarmth = clean.reduce((sum, s) => sum + warmth(s), 0) / clean.length;
  const accent = mix(mostChromatic, colors.eclipseGold, avgWarmth >= warmThreshold ? 0.55 : 0.8);

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
