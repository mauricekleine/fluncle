// Audio-reactive hooks for the Nostalgic Cosmos primitives. All compute from
// useCurrentFrame()/fps and the props arrays only: pure and deterministic, safe
// for headless renders. Feed them the composition's audio.* arrays.

export { useBeat, type BeatState, type UseBeatOptions } from "./use-beat";
export { useOnset } from "./use-onset";
export { useEnergy, type UseCurveOptions } from "./use-energy";
export { useBass } from "./use-bass";
export {
  useAudioReactivity,
  type AudioReactivity,
  type AudioReactivityOptions,
  type DropEnvelopeOptions,
} from "./use-audio-reactivity";
export { sampleCurve, smoothCurveAtFrame } from "./sample-curve";
