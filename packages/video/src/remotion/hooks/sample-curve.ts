import { type EnergySample } from "../types";

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

  let lo = 1;
  let hi = curve.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].timeMs >= timeMs) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  const next = curve[lo];
  const prev = curve[lo - 1];
  const span = next.timeMs - prev.timeMs;
  if (span <= 0) {
    return next.energy;
  }
  const t = (timeMs - prev.timeMs) / span;
  return prev.energy + (next.energy - prev.energy) * t;
};

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
  const k = Math.max(0, Math.min(decay, 0.9999));
  if (k <= 0) {
    return at(frame);
  }
  const lookback = Math.ceil(6 / (1 - k));
  const fromFrame = Math.max(0, frame - lookback);
  let h = 0;
  for (let f = fromFrame; f <= frame; f++) {
    h = h * k + at(f) * (1 - k);
  }
  return h;
};
