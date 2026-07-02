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
  /**
   * Defaults to the analyzer's detected drop (`audio.dropMs` — breakdown→slam
   * novelty) when present, else the strongest energy sample in the clip. Set
   * explicitly to override both.
   */
  peakTimeMs?: number;
  /** Milliseconds before the peak used for the rise. Default 700. */
  riseMs?: number;
  /** Milliseconds held at the peak before falling. Default 250. */
  holdMs?: number;
  /** Milliseconds after the hold used for the fall. Default 900. */
  fallMs?: number;
  /** Floor while outside the drop window. Default 0. */
  floor?: number;
};

export type AudioReactivityOptions = {
  beatDecay?: number;
  /** Exponential decay of the bar-downbeat pulse. Default 2.2 (breathes across the bar). */
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
  /** Smoothed global energy, for broad exposure and material pressure. */
  energy: number;
  /** Tighter low-end energy (kick/sub), for thickness, refraction, body, glow breadth. */
  bass: number;
  /** Mid-band energy (150Hz-2kHz: lead/vocal/snare). Map to a DIFFERENT element than bass. */
  mid: number;
  /** Treble-band energy (>2kHz: hats/cymbals/air). The liveliest band — fine detail/sparkle. */
  treble: number;
  /** Near-raw energy, useful for sharper but non-positional material disruption. */
  energyFast: number;
  /** Near-raw bass, useful for pressure changes without waiting on smoothing. */
  bassFast: number;
  /** Near-raw mid, for snappier lead-driven material reactions. */
  midFast: number;
  /** Near-raw treble, for snappy hat/cymbal-driven sparkle. */
  trebleFast: number;
  /** Continuous transient/attack (flux) envelope — between-onset shimmer. */
  flux: number;
  /** Smoothed sub weight (<60Hz) — low-end pressure/mass, slower than bass. 0 without subCurve. */
  sub: number;
  /** Near-raw transient-emphasized kick punch (60-150Hz) — the strike, a MATERIAL signal. 0 without kickCurve. */
  kickHit: number;
  /** Near-raw transient-emphasized snare crack (2-5kHz) — the backbeat, a MATERIAL signal. 0 without snareCurve. */
  snareHit: number;
  /** Air band (>5kHz) — hat tails/cymbal wash, fine sparkle. 0 without airCurve. */
  air: number;
  /** Beat-grid pulse, snap-to-one and exponential decay. */
  beat: number;
  /** Bar-downbeat pulse — snaps on the one, decays across the bar. 0 without downbeats. */
  downbeat: number;
  /** Onset transient pulse, usually shorter than beat. */
  onset: number;
  /** Beat + onset composite for immediate material hits. */
  hit: number;
  /** Bass/energy-led motion signal (no per-beat by default). The safe driver for travel/flow/convergence — it glides, it never per-beat snaps. */
  swell: number;
  /** Peak envelope, usually around the strongest musical moment in the cut. */
  drop: number;
  /** The drop time driving the envelope: `audio.dropMs` when the analyzer found a real drop, else the loudest energy sample. */
  peakTimeMs?: number;
  /**
   * Ready-to-spread shader uniforms. These are intentionally named as audio
   * signals, not visual instructions; the scene still decides what they disturb.
   */
  uniforms: Record<string, number>;
};

// --- Pure composite math (exported for tests: no React/Remotion needed) ------

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge0 === edge1) {
    return x >= edge1 ? 1 : 0;
  }
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** The loudest sample's time — the drop fallback when the analyzer shipped no dropMs. */
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

/** Rise/hold/fall envelope around the drop. Explicit `options.peakTimeMs` wins over the detected peak. */
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

/** Beat + onset composite for immediate MATERIAL hits (see the bus doc). */
export const computeHit = (
  beat: number,
  onset: number,
  beatWeight = 0.62,
  onsetWeight = 0.5,
): number => clamp01(beat * beatWeight + onset * onsetWeight);

/**
 * The bass/energy-led MOTION composite. The per-beat term defaults to 0 (see
 * the swell rationale in the hook body); bass+energy weights sum to 1.0 so a
 * real drop drives swell to the full 1.0.
 */
export const computeSwell = (
  swellBeat: number,
  bass: number,
  energy: number,
  beatWeight = 0,
  bassWeight = 0.6,
  energyWeight = 0.4,
): number => clamp01(swellBeat * beatWeight + bass * bassWeight + energy * energyWeight);

/** hit+swell+drop — the general material disruption signal (u_audioDisturbance). */
export const computeDisturbance = (hit: number, swell: number, drop: number): number =>
  clamp01(hit * 0.6 + swell * 0.45 + drop * 0.25);

/**
 * The drop envelope's default peak: the analyzer's detected drop when present
 * (`audio.dropMs`, breakdown→slam novelty — the musical moment), else the
 * loudest energy sample (which on spiky D&B picks an arbitrary kick).
 */
export const resolveDropPeakTimeMs = (
  dropMs: number | undefined,
  energyCurve: EnergySample[],
): number | undefined => dropMs ?? findPeakTimeMs(energyCurve);

/**
 * A shared audio-reactivity bus for track compositions.
 *
 * These signals disturb the vehicle's MATERIAL (width, density, radius,
 * threshold, exposure, grain, refraction, glow) on the immediate beat, and may
 * also drive its MOTION (travel, flow, convergence) — but motion only through a
 * SMOOTHED value (use `swell`/`drop`/`energy`, or smooth `hit` with attack/decay
 * yourself), never the raw per-beat transient, so movement glides and never
 * snaps (Motion law, doctrine 7). In short: audio disturbs the material AND
 * moves the picture, never just illuminates it.
 *
 * Why `swell` is safe for motion: it is bass/energy-led and carries NO per-beat by
 * default (`swellBeatWeight` is 0). Do NOT raise that weight or route `beat` /
 * `hit` / `u_beatPulse` into motion to "make it dance" — at high BPM that is the
 * exact source of per-1/4-note jitter. The beat belongs in MATERIAL (`hit`).
 */
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
  // swellBeat feeds MOTION, so it decays slowly: at high BPM a fast decay leaves a
  // per-beat sawtooth that makes movement lurch. A slow decay blurs consecutive
  // beats into a continuous breath instead.
  const { pulse: swellBeat } = useBeat(audio.beatGrid, { decay: options.swellDecay ?? 0.8 });
  const onset = useOnset(audio.onsets, options.onsetWindowMs ?? 140);

  // Explicit `options.drop.peakTimeMs` still wins inside dropEnvelope.
  const peakTimeMs = useMemo(
    () => resolveDropPeakTimeMs(audio.dropMs, audio.energyCurve),
    [audio.dropMs, audio.energyCurve],
  );
  const drop = dropEnvelope(nowMs, peakTimeMs, options.drop);

  const hit = computeHit(beat, onset, options.hitBeatWeight, options.hitOnsetWeight);
  // swell drives MOTION, so it is purely bass/energy-led: the per-beat term
  // (swellBeatWeight) defaults to 0. ANY beat weight here makes the picture surge
  // on every 1/4 note, which reads as jitter at high BPM — proven on the 173 BPM
  // D&B tracks, where even 0.14 still ticked and 0 looked markedly smoother. Keep
  // motion gliding on the bass/energy envelopes; let `hit` (not swell) carry the
  // sharp on-beat MATERIAL. Only raise the beat weight for a slow track where a
  // faint motional beat-lock genuinely won't strobe. The bass+energy weights sum
  // to 1.0 (0.6 + 0.4) so a real drop where both peak drives swell to the full
  // 1.0; clamp01 is now a guarantee, not a ceiling.
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
    // The bag's only legitimate entry: u_audioDisturbance is the one uniform
    // ShaderLayer reads from here. Every other audio signal lives in the HEADER
    // and is pushed by name (audio.bass, audio.swell, audio.flux, …), so a shader
    // declaring it by name always gets a real value — no silent-zero aliases.
    uniforms: {
      u_audioDisturbance: disturbance,
    },
  };
};
