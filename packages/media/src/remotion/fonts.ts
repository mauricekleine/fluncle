import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

export const OXANIUM = "Oxanium" as const;

export const SPACE_GROTESK = "Space Grotesk" as const;

export const OXANIUM_STACK = "Oxanium, ui-sans-serif, system-ui, sans-serif" as const;

export const SPACE_GROTESK_STACK = "Space Grotesk, ui-sans-serif, system-ui, sans-serif" as const;

const OXANIUM_BOX = {
  ascentOverride: "97%",
  descentOverride: "28%",
  lineGapOverride: "0%",
  weight: "200 800",
} as const;

const SPACE_GROTESK_BOX = {
  ascentOverride: "97.5%",
  descentOverride: "27.5%",
  lineGapOverride: "0%",
  weight: "300 700",
} as const;

const LATIN_RANGE =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

const LATIN_EXT_RANGE =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

let loadPromise: Promise<void> | null = null;

export const loadBrandFonts = (): Promise<void> => {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = Promise.all([
    loadFont({
      ...OXANIUM_BOX,
      family: OXANIUM,
      format: "woff2",
      unicodeRange: LATIN_RANGE,
      url: staticFile("fonts/oxanium-latin.woff2"),
    }),
    loadFont({
      ...OXANIUM_BOX,
      family: OXANIUM,
      format: "woff2",
      unicodeRange: LATIN_EXT_RANGE,
      url: staticFile("fonts/oxanium-latin-ext.woff2"),
    }),
    loadFont({
      ...SPACE_GROTESK_BOX,
      family: SPACE_GROTESK,
      format: "woff2",
      unicodeRange: LATIN_RANGE,
      url: staticFile("fonts/space-grotesk-latin.woff2"),
    }),
    loadFont({
      ...SPACE_GROTESK_BOX,
      family: SPACE_GROTESK,
      format: "woff2",
      unicodeRange: LATIN_EXT_RANGE,
      url: staticFile("fonts/space-grotesk-latin-ext.woff2"),
    }),
  ]).then(() => undefined);

  return loadPromise;
};

void loadBrandFonts();
