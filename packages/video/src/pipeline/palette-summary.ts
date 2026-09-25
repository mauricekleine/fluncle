export const PALETTE_BUCKETS = [
  "red-hot",
  "amber-warm",
  "yellow-warm",
  "green-cool",
  "teal-cool",
  "blue-cool",
  "indigo-cool",
  "magenta-cool",
  "neutral-mono",
] as const;

export type PaletteBucket = (typeof PALETTE_BUCKETS)[number];

const SAT_FLOOR = 0.15;
const VAL_FLOOR = 0.1;

export type Hsv = { h: number; s: number; v: number };

export function parseHex(hex: string): [number, number, number] | null {
  if (typeof hex !== "string") {
    return null;
  }
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return null;
  }
  const r = Number.parseInt(h.slice(0, 2), 16) / 255;
  const g = Number.parseInt(h.slice(2, 4), 16) / 255;
  const b = Number.parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  let h = 0;
  if (c > 1e-6) {
    if (max === r) {
      h = ((g - b) / c) % 6;
    } else if (max === g) {
      h = (b - r) / c + 2;
    } else {
      h = (r - g) / c + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  return { h, s: max > 1e-6 ? c / max : 0, v: max };
}

export function hueBucketOf(hex: string): PaletteBucket {
  const rgb = parseHex(hex);
  if (!rgb) {
    return "neutral-mono";
  }
  const { h, s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  if (s < SAT_FLOOR || v < VAL_FLOOR) {
    return "neutral-mono";
  }

  if (h >= 345 || h < 15) {
    return "red-hot";
  }
  if (h < 45) {
    return "amber-warm";
  }
  if (h < 70) {
    return "yellow-warm";
  }
  if (h < 160) {
    return "green-cool";
  }
  if (h < 200) {
    return "teal-cool";
  }
  if (h < 255) {
    return "blue-cool";
  }
  if (h < 290) {
    return "indigo-cool";
  }
  return "magenta-cool";
}

export type PaletteInput = {
  accent?: string | null;
  background?: string | null;
  glow?: string | null;
  ink?: string | null;
  swatches?: readonly string[] | null;
};

export type PaletteSummary = {
  bucket: PaletteBucket;

  swatches: string[];
};

export function summarizePalette(palette: PaletteInput): PaletteSummary {
  const accent = normalizeHex(palette.accent);
  const glow = normalizeHex(palette.glow);
  const background = normalizeHex(palette.background);

  const accentChroma = chromaOf(accent);
  const glowChroma = chromaOf(glow);
  const defining = glowChroma > accentChroma ? glow : accent;
  const bucket = defining ? hueBucketOf(defining) : "neutral-mono";

  const swatches: string[] = [];
  for (const hex of [accent, glow, background]) {
    if (hex && !swatches.includes(hex)) {
      swatches.push(hex);
    }
  }
  return { bucket, swatches };
}

function normalizeHex(hex: string | null | undefined): string | null {
  if (typeof hex !== "string") {
    return null;
  }
  const rgb = parseHex(hex);
  if (!rgb) {
    return null;
  }
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function chromaOf(hex: string | null): number {
  if (!hex) {
    return 0;
  }
  const rgb = parseHex(hex);
  if (!rgb) {
    return 0;
  }
  const { s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  return s * v;
}
