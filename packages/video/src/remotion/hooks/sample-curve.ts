import { type EnergySample } from "../types";

/**
 * Linearly interpolates an energy/bass curve at an arbitrary time in ms.
 *
 * The curve is assumed sorted ascending by `timeMs` (the pipeline emits it that
 * way). Out-of-range times clamp to the first/last sample. Returns 0 for an
 * empty curve so compositions degrade gracefully with placeholder props.
 *
 * Pure and deterministic: same inputs always yield the same output.
 */
export const sampleCurve = (curve: EnergySample[], timeMs: number): number => {
  if (curve.length === 0) {
    return 0;
  }

  const first = curve[0];
  if (timeMs <= first.timeMs) {
    return first.energy;
  }

  const last = curve[curve.length - 1];
  if (timeMs >= last.timeMs) {
    return last.energy;
  }

  // Linear scan is fine: curves are short (one sample per ~frame at most) and
  // a render walks frames forward, so this stays cheap and branch-predictable.
  for (let i = 1; i < curve.length; i++) {
    const next = curve[i];
    if (timeMs <= next.timeMs) {
      const prev = curve[i - 1];
      const span = next.timeMs - prev.timeMs;
      if (span <= 0) {
        return next.energy;
      }
      const t = (timeMs - prev.timeMs) / span;
      return prev.energy + (next.energy - prev.energy) * t;
    }
  }

  return last.energy;
};

/**
 * One-pole exponential smoothing across recent frames so a curve drives motion
 * without per-frame jitter. `smoothingFrames` is the approximate window; larger
 * is smoother and laggier. Walks backward from the current frame and weights
 * older samples less. Deterministic.
 */
export const smoothCurveAtFrame = (
  curve: EnergySample[],
  frame: number,
  fps: number,
  startMs: number,
  smoothingFrames: number,
): number => {
  if (curve.length === 0) {
    return 0;
  }

  if (smoothingFrames <= 1) {
    return sampleCurve(curve, startMs + (frame / fps) * 1000);
  }

  // alpha tuned so the window has ~63% of its weight inside smoothingFrames.
  const alpha = 1 - Math.exp(-1 / smoothingFrames);
  const lookback = Math.ceil(smoothingFrames * 3);
  const fromFrame = Math.max(0, frame - lookback);

  let value = sampleCurve(curve, startMs + (fromFrame / fps) * 1000);
  for (let f = fromFrame + 1; f <= frame; f++) {
    const target = sampleCurve(curve, startMs + (f / fps) * 1000);
    value = value + (target - value) * alpha;
  }

  return value;
};

/**
 * A leaky integrator over a KNOWN curve — hysteresis the world can carry ("the world
 * remembers the drop"). Unlike `smoothCurveAtFrame` (a windowed EMA that forgets
 * within a short window), this integrates with the pole `decay`: `h[n] = h[n-1]·decay
 * + x[n]·(1 − decay)`, so a surge (the drop) makes the value CLIMB and then LINGER,
 * decaying slowly — scorch that accumulates, ruins that stay lit after the climax.
 *
 * `decay` ∈ [0, 1): 0 = no memory (returns the raw sample), higher = longer memory.
 * The value stays in the curve's range (a 0..1 curve gives a 0..1 result). Pure and
 * FRAME-STABLE: the value at frame N depends only on the curve, so it is identical
 * across render chunks/tabs (the deterministic answer to GPU feedback, which is
 * foreclosed). Contributions older than ~6/(1−decay) frames weigh < e⁻⁶ (< 0.25%),
 * so the walk is bounded there — O(memory) per frame, within 0.25% of the full-clip
 * integral. Cold-start (the world begins unburned).
 */
export const accumulateCurveAtFrame = (
  curve: EnergySample[],
  frame: number,
  fps: number,
  startMs: number,
  decay: number,
): number => {
  if (curve.length === 0) {
    return 0;
  }
  const at = (f: number): number => sampleCurve(curve, startMs + (f / fps) * 1000);
  const k = Math.max(0, Math.min(decay, 0.9999)); // keep the pole in [0, 1)
  if (k <= 0) {
    return at(frame); // no memory → the raw sample
  }
  const lookback = Math.ceil(6 / (1 - k));
  const fromFrame = Math.max(0, frame - lookback);
  let h = 0;
  for (let f = fromFrame; f <= frame; f++) {
    h = h * k + at(f) * (1 - k);
  }
  return h;
};
