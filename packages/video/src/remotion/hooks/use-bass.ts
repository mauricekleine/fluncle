import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";
import { type UseCurveOptions } from "./use-energy";

/**
 * Smoothed 0..1 low-end energy at the current frame. Tighter smoothing than
 * useEnergy by default so the sub follows the bassline: drives the eclipse
 * rim swell, tower-window brightness, the kaleidoscope breathing. Deterministic.
 */
export const useBass = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 3);
};
