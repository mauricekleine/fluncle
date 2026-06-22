// Small, dependency-free color helpers for the primitives. Pure functions only;
// no randomness, no DOM. Hex in, hex/rgba out.
//
// node-vibrant (the pipeline's swatch extractor) is intentionally NOT imported
// here: these helpers run inside compositions and must stay deterministic and
// browser-safe. The pipeline extracts swatches; paletteMix blends them.

export type Rgb = { r: number; g: number; b: number };

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));

/** Parses #rgb / #rrggbb (with or without leading #). Returns black on garbage. */
export const hexToRgb = (hex: string): Rgb => {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) {
    return { b: 0, g: 0, r: 0 };
  }
  return {
    b: parseInt(h.slice(4, 6), 16),
    g: parseInt(h.slice(2, 4), 16),
    r: parseInt(h.slice(0, 2), 16),
  };
};

export const rgbToHex = ({ r, g, b }: Rgb): string => {
  const toHex = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

/** rgba() string from a hex plus alpha 0..1. Handy for veils and glows. */
export const withAlpha = (hex: string, alpha: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
};

/** Linear blend between two hex colors. amount 0 = a, 1 = b. */
export const mix = (a: string, b: string, amount: number): string => {
  const t = clamp01(amount);
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    b: ca.b + (cb.b - ca.b) * t,
    g: ca.g + (cb.g - ca.g) * t,
    r: ca.r + (cb.r - ca.r) * t,
  });
};

/** Perceived luminance 0..1 (Rec. 601 weights). */
export const luminance = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/**
 * Warmth heuristic -1..1: how much a color leans toward warm (red/yellow) vs
 * cool (blue). Positive = warm. Used to decide whether the accent should bias
 * toward Eclipse Gold or keep the artwork's own accent.
 */
export const warmth = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex);
  return clamp01((r + g * 0.5) / 255) - clamp01(b / 255);
};

/** Approximate HSL saturation 0..1, for picking the most chromatic swatch. */
export const saturation = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) {
    return 0;
  }
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
};
