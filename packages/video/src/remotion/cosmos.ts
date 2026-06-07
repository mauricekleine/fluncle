// Public API surface for the Nostalgic Cosmos video package. The exemplar comp
// (and the agent that composes future pieces) imports everything from here.
//
// DESIGN.md is the visual canon; VOICE.md is the copy canon. These primitives
// encode the brand grammar: grain over everything, one Eclipse Gold accent
// moment (the Eclipse), Oxanium for brand marks and numerals, warm darks only,
// floaty drift, "Artist — Title" em dash, "Discovered Jun 4" tabular dates.

// Visual primitives
export * from "./primitives";

// Audio-reactive hooks
export * from "./hooks";

// Journey component set (travelling vehicles, brand-law trio, narrative clock)
export * from "./journey";

// Typography font loader
export { OXANIUM, OXANIUM_STACK, loadOxanium } from "./fonts";

// Palette + color helpers
export { paletteMix, type PaletteMixOptions } from "./palette-mix";
export {
  hexToRgb,
  rgbToHex,
  withAlpha,
  mix,
  luminance,
  warmth,
  saturation,
  type Rgb,
} from "./color";

// Shared contract types
export type {
  NostalgicCosmosProps,
  CosmosTrack,
  CosmosAudio,
  CosmosPalette,
  EnergySample,
} from "./types";
