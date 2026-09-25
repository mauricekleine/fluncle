import { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { type CosmosAudio, type EnergySample } from "../types";
import { useAir } from "./use-air";
import { useBass } from "./use-bass";
import { useBeat } from "./use-beat";
import { useDownbeat } from "./use-downbeat";
import { useEnergy, type UseCurveOptions } from "./use-energy";
import { useFlux } from "./use-flux";
import { useKick } from "./use-kick";
import { useMid } from "./use-mid";
import { useOnset } from "./use-onset";
import { useSnare } from "./use-snare";
import { useSub } from "./use-sub";
import { useTreble } from "./use-treble";

type AudioReactivityInput = Pick<
  CosmosAudio,
  | "airCurve"
  | "bassCurve"
  | "beatGrid"
  | "downbeats"
  | "dropMs"
  | "energyCurve"
  | "fluxCurve"
  | "kickCurve"
  | "midCurve"
  | "onsets"
  | "snareCurve"
  | "subCurve"
  | "trebleCurve"
>;

export type DropEnvelopeOptions = {
  peakTimeMs?: number;

  riseMs?: number;

  holdMs?: number;

  fallMs?: number;

  floor?: number;
};

export type AudioReactivityOptions = {
  beatDecay?: number;

  downbeatDecay?: number;
  swellDecay?: number;
  onsetWindowMs?: number;
  energy?: UseCurveOptions;
  bass?: UseCurveOptions;
  mid?: UseCurveOptions;
  treble?: UseCurveOptions;
  flux?: UseCurveOptions;
  sub?: UseCurveOptions;
  kick?: UseCurveOptions;
  snare?: UseCurveOptions;
  air?: UseCurveOptions;
  fastEnergy?: UseCurveOptions;
  fastBass?: UseCurveOptions;
  fastMid?: UseCurveOptions;
  fastTreble?: UseCurveOptions;
  hitBeatWeight?: number;
  hitOnsetWeight?: number;
  swellBeatWeight?: number;
  swellBassWeight?: number;
  swellEnergyWeight?: number;
  drop?: DropEnvelopeOptions;
};

export type AudioReactivity = {
  energy: number;

  bass: number;

  mid: number;

  treble: number;

  energyFast: number;

  bassFast: number;

  midFast: number;

  trebleFast: number;

  flux: number;

  sub: number;

  kickHit: number;

  snareHit: number;

  air: number;

  beat: number;

  downbeat: number;

  onset: number;

  hit: number;

  swell: number;

  drop: number;

  peakTimeMs?: number;

  uniforms: Record<string, number>;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge0 === edge1) {
    return x >= edge1 ? 1 : 0;
  }
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export const findPeakTimeMs = (curve: EnergySample[]): number | undefined => {
  if (curve.length === 0) {
    return undefined;
  }

  let peak = curve[0];
  for (const sample of curve) {
    if (sample.energy > peak.energy) {
      peak = sample;
    }
  }
  return peak.timeMs;
};

export const dropEnvelope = (
  nowMs: number,
  peakTimeMs: number | undefined,
  options: DropEnvelopeOptions | undefined,
): number => {
  const peak = options?.peakTimeMs ?? peakTimeMs;

  if (peak === undefined) {
    return 0;
  }

  const riseMs = options?.riseMs ?? 700;
  const holdMs = options?.holdMs ?? 250;
  const fallMs = options?.fallMs ?? 900;
  const floor = options?.floor ?? 0;

  const rise = smoothstep(peak - riseMs, peak, nowMs);
  const fall = 1 - smoothstep(peak + holdMs, peak + holdMs + fallMs, nowMs);
  return clamp01(floor + (1 - floor) * rise * fall);
};

export const computeHit = (
  beat: number,
  onset: number,
  beatWeight = 0.62,
  onsetWeight = 0.5,
): number => clamp01(beat * beatWeight + onset * onsetWeight);

export const computeSwell = (
  swellBeat: number,
  bass: number,
  energy: number,
  beatWeight = 0,
  bassWeight = 0.6,
  energyWeight = 0.4,
): number => clamp01(swellBeat * beatWeight + bass * bassWeight + energy * energyWeight);

export const computeDisturbance = (hit: number, swell: number, drop: number): number =>
  clamp01(hit * 0.6 + swell * 0.45 + drop * 0.25);

export const resolveDropPeakTimeMs = (
  dropMs: number | undefined,
  energyCurve: EnergySample[],
): number | undefined => dropMs ?? findPeakTimeMs(energyCurve);

export const useAudioReactivity = (
  audio: AudioReactivityInput,
  options: AudioReactivityOptions = {},
): AudioReactivity => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;

  const energy = useEnergy(audio.energyCurve, options.energy);
  const bass = useBass(audio.bassCurve, options.bass);
  const mid = useMid(audio.midCurve, options.mid);
  const treble = useTreble(audio.trebleCurve, options.treble);
  const energyFast = useEnergy(audio.energyCurve, {
    smoothingFrames: 1,
    ...options.fastEnergy,
  });
  const bassFast = useBass(audio.bassCurve, {
    smoothingFrames: 1,
    ...options.fastBass,
  });
  const midFast = useMid(audio.midCurve, {
    smoothingFrames: 1,
    ...options.fastMid,
  });
  const trebleFast = useTreble(audio.trebleCurve, {
    smoothingFrames: 1,
    ...options.fastTreble,
  });
  const flux = useFlux(audio.fluxCurve ?? [], options.flux);
  const sub = useSub(audio.subCurve ?? [], options.sub);
  const kickHit = useKick(audio.kickCurve ?? [], options.kick);
  const snareHit = useSnare(audio.snareCurve ?? [], options.snare);
  const air = useAir(audio.airCurve ?? [], options.air);
  const { pulse: beat } = useBeat(audio.beatGrid, { decay: options.beatDecay ?? 3.2 });
  const { pulse: downbeat } = useDownbeat(audio.downbeats ?? [], {
    decay: options.downbeatDecay ?? 2.2,
  });

  const { pulse: swellBeat } = useBeat(audio.beatGrid, { decay: options.swellDecay ?? 0.8 });
  const onset = useOnset(audio.onsets, options.onsetWindowMs ?? 140);

  const peakTimeMs = useMemo(
    () => resolveDropPeakTimeMs(audio.dropMs, audio.energyCurve),
    [audio.dropMs, audio.energyCurve],
  );
  const drop = dropEnvelope(nowMs, peakTimeMs, options.drop);

  const hit = computeHit(beat, onset, options.hitBeatWeight, options.hitOnsetWeight);

  const swell = computeSwell(
    swellBeat,
    bass,
    energy,
    options.swellBeatWeight,
    options.swellBassWeight,
    options.swellEnergyWeight,
  );
  const disturbance = computeDisturbance(hit, swell, drop);

  return {
    air,
    bass,
    bassFast,
    beat,
    downbeat,
    drop,
    energy,
    energyFast,
    flux,
    hit,
    kickHit,
    mid,
    midFast,
    onset,
    peakTimeMs,
    snareHit,
    sub,
    swell,
    treble,
    trebleFast,

    uniforms: {
      u_audioDisturbance: disturbance,
    },
  };
};
