// Audio-reactive hooks for the Nostalgic Cosmos primitives. All compute from
// useCurrentFrame()/fps and the props arrays only: pure and deterministic, safe
// for headless renders. Feed them the composition's audio.* arrays.

export { useBeat, type BeatState, type UseBeatOptions } from "./use-beat";
export { useDownbeat } from "./use-downbeat";
export { useOnset } from "./use-onset";
export { useEnergy, type UseCurveOptions } from "./use-energy";
export { useBass } from "./use-bass";
export { useMid } from "./use-mid";
export { useTreble } from "./use-treble";
export { useFlux } from "./use-flux";
export { useSub } from "./use-sub";
export { useKick } from "./use-kick";
export { useSnare } from "./use-snare";
export { useAir } from "./use-air";
export {
  useAudioReactivity,
  type AudioReactivity,
  type AudioReactivityOptions,
  type DropEnvelopeOptions,
} from "./use-audio-reactivity";
export { sampleCurve, smoothCurveAtFrame } from "./sample-curve";
