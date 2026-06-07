// The surviving journey machinery: the GPU shader workhorse + GLSL snippet
// library, the shared narrative clock (useJourney), and the CloseCard brand law.
// The travelling-vehicle components and the Plate/Retint helpers are gone — each
// track now authors its OWN scene code (inlined shaders/components) and reaches
// for this machinery directly. The creative doctrine (the One Vehicle Rule, the
// Retint Rule, texture families) lives in the fluncle-video skill, not here.
//
// All are deterministic (frame-/seed-/curve-derived only). See DESIGN.md (visual
// canon) and VOICE.md (copy canon).

// Shared narrative clock
export {
  useJourney,
  type JourneyPhase,
  type JourneyState,
  type UseJourneyOptions,
} from "./use-journey";

// GPU shader workhorse + composable GLSL snippet library
export { ShaderLayer, type ShaderLayerProps, type ShaderUniformValue } from "./shader-layer";
export { GLSL, type GlslSnippet } from "./glsl";

// Brand law: the mandatory close card
export { CloseCard, type CloseCardProps } from "./close-card";
