// The single public surface of the @fluncle/video package. This is a near-blank
// canvas: the package ships machinery (the ShaderLayer GPU workhorse + the GLSL
// snippet library, the audio-reactive hooks, the journey clock) and brand law
// (Grain, Starfield, FloatingType's legibility guarantee, CloseCard, paletteMix's
// canon lock) — and nothing else. Each track composition authors its OWN scene
// code, inlining whatever shaders and components it needs and importing only what
// is exported here. The creative doctrine — vehicles, texture families, type
// staging, research — lives in the fluncle-video skill, not in this code.
//
// DESIGN.md is the visual canon; VOICE.md is the copy canon.

// Brand-law primitives (Grain, Starfield, FloatingType)
export * from "./primitives";

// Audio-reactive hooks
export * from "./hooks";

// Journey machinery (ShaderLayer + GLSL, the narrative clock) and CloseCard
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
