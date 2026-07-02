import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";
import { type UseCurveOptions } from "./use-energy";

/**
 * Smoothed 0..1 sub weight (<60Hz) at the current frame — the low-end floor
 * under the kick. Slower default smoothing than useBass: sub is pressure, not
 * punch — drive mass, density, glow breadth with it. Deterministic.
 */
export const useSub = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 4);
};
