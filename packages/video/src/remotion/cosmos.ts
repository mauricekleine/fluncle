// The single public surface of the @fluncle/video package. This is a near-blank
// canvas — it ships MACHINERY (the ShaderLayer GPU workhorse + the GLSL snippet
// library, the audio-reactive hooks, the journey clock), the fixed INFORMATION
// layer (TypePlate / FloatingType / CloseCard — so every video's Log ID, credits
// and signature render identically), and a SCENE-LED palette helper — and no
// imposed look. There is no Grain overlay and no Starfield: texture/grain and any
// background are the agent's own, baked into its shader (`GLSL.filmGrain` is a
// tool, not a mandate). Each track composition authors its OWN scene code,
// importing only what is exported here. The creative doctrine — vehicles, texture
// families, type staging — lives in the fluncle-video skill, not in this code.
//
// DESIGN.md is the visual canon; VOICE.md is the copy canon.

// Information layer (TypePlate / FloatingType / CloseCard) + audio binding
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
