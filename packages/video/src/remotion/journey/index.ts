// The Journey component set: the travelling vehicles for the One Vehicle Rule
// (orb, lines, fractal, glass, glitch) plus the brand-law trio (Retint, Plate,
// CloseCard) and the shared narrative clock (useJourney). Every video is a
// journey carried by exactly one vehicle; these encode that grammar.
//
// All are deterministic (frame-/seed-/curve-derived only) and CPU-friendly
// (SVG + CSS compositing, no canvas, no WebGL). See DESIGN.md (visual canon),
// VOICE.md (copy canon), and moodboard/MOODBOARD.md (texture families, the
// Retint Rule, the One Vehicle Rule).

// Shared narrative clock
export {
  useJourney,
  type JourneyPhase,
  type JourneyState,
  type UseJourneyOptions,
} from "./use-journey";

// Travelling vehicles (One Vehicle Rule)
export { JourneyOrb, type JourneyOrbProps, type OrbPath, type OrbPlacement } from "./journey-orb";
export {
  JourneyLines,
  type JourneyLinesDisplacement,
  type JourneyLinesMode,
  type JourneyLinesPreset,
  type JourneyLinesProps,
} from "./journey-lines";
export { JourneyFractal, type JourneyFractalProps } from "./journey-fractal";
export { JourneyGlass, type JourneyGlassProps, type JourneyGlassSweep } from "./journey-glass";
export {
  JourneyGlitch,
  type JourneyGlitchDensityPreset,
  type JourneyGlitchMode,
  type JourneyGlitchProps,
} from "./journey-glitch";

// GPU shader workhorse + composable GLSL snippet library
export { ShaderLayer, type ShaderLayerProps, type ShaderUniformValue } from "./shader-layer";
export { GLSL, type GlslSnippet } from "./glsl";

// Brand-law trio (Retint Rule, plates, close card)
export { Retint, type RetintMode, type RetintProps, type RetintStop } from "./retint";
export { Plate, type PlateDrift, type PlateDriftPreset, type PlateProps } from "./plate";
export { CloseCard, type CloseCardProps } from "./close-card";
