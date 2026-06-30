// The core's non-negotiable layers: the fixed INFORMATION layer (TypePlate /
// FloatingType / CloseCard enforce that every video's Log ID, credits, Found
// date and "selected by Fluncle" signature render identically — consistency, not
// a look) plus the audio binding. NO aesthetic is imposed: there is no Grain
// overlay and no Starfield — texture (grain, degradation) and any background
// detail are the agent's own, baked into its shader (the Light-Years Rule;
// `GLSL.filmGrain` is available as a tool). All deterministic. See DESIGN.md /
// VOICE.md.

export { FloatingType, type FloatingTypeProps, type FloatingTypeVariant } from "./floating-type";
export { TypePlate, type TypePlateProps } from "./type-plate";
export { TrackAudio } from "./track-audio";
