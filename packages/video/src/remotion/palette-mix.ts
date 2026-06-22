import { colors } from "@fluncle/tokens";
import { type CosmosPalette } from "./types";
import { luminance, mix, saturation } from "./color";

export type PaletteMixOptions = {
  /**
   * How far the background is allowed to drift from Deep Field toward the
   * artwork's darkest swatch. Kept small: the Warm Dark Rule says the night sky
   * stays a warm near-black. 0..1, default 0.18.
   */
  backgroundDrift?: number;
};

/**
 * Derives the composition palette (CosmosPalette) from the artwork swatches.
 *
 * SCENE-LED, not brand-locked. The ONE rule still encoded is the Warm Dark Rule:
 * `background` stays a warm near-black, only nudged toward the artwork's darkest
 * swatch. Everything else comes from the artwork:
 * - `accent` is the artwork's OWN most-chromatic swatch — NO gold lean. A cool
 *   sleeve yields a cool accent; a warm one yields a warm accent. (This replaces
 *   the old "always lean to Eclipse Gold / One Sun" rule, which forced a gold
 *   pop onto every climax regardless of palette.)
 * - `glow` is that accent lifted toward the artwork's brightest swatch — the
 *   scene's own hot light, not a reserved gold.
 * - `ink` keeps Starlight Cream legible, lifted slightly toward the brightest.
 *
 * `accent` and `glow` are LIGHT MATERIAL for the vehicle/shaders — never type ink
 * (type takes `ink` or a scene-derived swatch). Gold is no longer special here:
 * if the artwork is warm/gold, the accent reads gold on its own; it is never
 * imposed.
 *
 * Pure and deterministic. Falls back to the brand palette ONLY when no swatches
 * are supplied (placeholder props with no artwork), so the empty state still
 * renders on-brand.
 */
export const paletteMix = (swatches: string[], options: PaletteMixOptions = {}): CosmosPalette => {
  const backgroundDrift = options.backgroundDrift ?? 0.18;

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
  const darkest = sorted[0];
  const brightest = sorted[sorted.length - 1];

  // Most chromatic swatch is the artwork's natural accent.
  const mostChromatic = [...clean].sort((a, b) => saturation(b) - saturation(a))[0];

  // Background: warm near-black, gently drifted toward the artwork's darkest.
  const background = mix(colors.deepField, darkest, backgroundDrift);

  // Accent: the scene's own chroma, no gold lean.
  const accent = mostChromatic;

  // Glow: the accent's hot light — lifted toward the artwork's brightest, so it
  // reads as the scene's own light, not a reserved gold sun.
  const glow = mix(accent, brightest, 0.6);

  // Ink: keep Starlight Cream legible; lift slightly toward the brightest swatch
  // so the type feels of-a-piece without losing the aged-paper cream.
  const ink = mix(colors.starlightCream, brightest, 0.12);

  return {
    accent,
    background,
    glow,
    ink,
    swatches: clean,
  };
};
