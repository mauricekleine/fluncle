export type Rgb = { r: number; g: number; b: number };

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));

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

export const withAlpha = (hex: string, alpha: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
};

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

export const luminance = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

export const warmth = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex);
  return clamp01((r + g * 0.5) / 255) - clamp01(b / 255);
};

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
