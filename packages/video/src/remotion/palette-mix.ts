import { colors } from "@fluncle/tokens";
import { type CosmosPalette } from "./types";
import { luminance, mix, saturation } from "./color";

export type PaletteMixOptions = {
  backgroundDrift?: number;
};

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

  const mostChromatic = [...clean].sort((a, b) => saturation(b) - saturation(a))[0];

  const background = mix(colors.deepField, darkest, backgroundDrift);

  const accent = mostChromatic;

  const glow = mix(accent, brightest, 0.6);

  const ink = mix(colors.starlightCream, brightest, 0.12);

  return {
    accent,
    background,
    glow,
    ink,
    swatches: clean,
  };
};
