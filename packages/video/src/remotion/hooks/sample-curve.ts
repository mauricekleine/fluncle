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

  const first = curve[0]!;
  if (timeMs <= first.timeMs) {
    return first.energy;
  }

  const last = curve[curve.length - 1]!;
  if (timeMs >= last.timeMs) {
    return last.energy;
  }

  // Linear scan is fine: curves are short (one sample per ~frame at most) and
  // a render walks frames forward, so this stays cheap and branch-predictable.
  for (let i = 1; i < curve.length; i++) {
    const next = curve[i]!;
    if (timeMs <= next.timeMs) {
      const prev = curve[i - 1]!;
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
