// The palette provenance summary — the missing diversity axis (docs/planning/
// homogenisation-evidence.md, 07-13 + 07-14): four of five consecutive renders shared
// one amber/sepia palette, and palette was invisible to every stored column. This turns
// a render's derived palette (social-preview's paletteMix, node-vibrant over the artwork)
// into two compact, DETERMINISTIC provenance values recorded in render.json and on the
// finding:
//
//   - a coarse HUE-BUCKET TAG (e.g. "amber-warm") — the string the render conductor's
//     deterministic axis assigner reads to steer the NEXT render off the worn hue.
//   - up to three dominant HEX swatches — the human-readable receipt in the bundle.
//
// The bucket is derived from HSV so it is stable and reproducible: the same palette
// always tags the same bucket. It is intentionally COARSE — the goal is to catch a
// palette basin (the whole feed sliding amber), not to grade fine hue differences.

/** The coarse hue buckets. Warm buckets sit up front — the amber/sepia basin the
 *  evidence names is `amber-warm`. `neutral-mono` is the low-chroma escape (a warm-dark
 *  field with no defining hue). This list is the closed vocabulary the ledger records. */
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

// Below this saturation OR value the swatch has no defining hue — it reads as a
// warm-dark/neutral field, so it buckets `neutral-mono` rather than an arbitrary hue.
const SAT_FLOOR = 0.15;
const VAL_FLOOR = 0.1;

export type Hsv = { h: number; s: number; v: number };

/** Parse `#rrggbb` / `#rgb` (or the same without the hash) to [r,g,b] in 0..1. Null on
 *  anything unparseable — the caller treats an unparseable swatch as absent. */
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

/** RGB (0..1) → HSV with hue in degrees [0,360). */
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

/** The coarse hue bucket of a single hex swatch. Unparseable/near-grey → neutral-mono. */
export function hueBucketOf(hex: string): PaletteBucket {
  const rgb = parseHex(hex);
  if (!rgb) {
    return "neutral-mono";
  }
  const { h, s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  if (s < SAT_FLOOR || v < VAL_FLOOR) {
    return "neutral-mono";
  }
  // Hue → bucket. Wrap-around red spans the top and bottom of the wheel.
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

/** The palette shape social-preview's paletteMix produces (CosmosPalette): the four
 *  composition stops plus the raw artwork swatches. Only the fields this summary reads
 *  are required. */
export type PaletteInput = {
  accent?: string | null;
  background?: string | null;
  glow?: string | null;
  ink?: string | null;
  swatches?: readonly string[] | null;
};

export type PaletteSummary = {
  /** The coarse hue-bucket tag recorded on the finding + read by the axis assigner. */
  bucket: PaletteBucket;
  /** Up to three dominant hex swatches — the bundle's human-readable receipt. */
  swatches: string[];
};

/** Summarize a render's palette into its provenance record. The BUCKET is derived from
 *  the palette's defining HEAT stop — the more chromatic of accent/glow (the light
 *  material that carries the palette's hue; `background` is a warm-dark near-constant and
 *  `ink` is cream, so neither defines the basin). When neither accent nor glow clears the
 *  chroma floor the palette is a neutral warm-dark field → `neutral-mono`. The recorded
 *  swatches are accent/glow/background (deduped, hash-normalized), the three that read. */
export function summarizePalette(palette: PaletteInput): PaletteSummary {
  const accent = normalizeHex(palette.accent);
  const glow = normalizeHex(palette.glow);
  const background = normalizeHex(palette.background);

  // The defining stop: whichever of accent/glow is the more chromatic (highest
  // saturation). Deterministic — accent wins an exact tie so the choice never wobbles.
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

/** Saturation×value of a swatch — its perceptual chroma; 0 when unparseable/null. */
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
