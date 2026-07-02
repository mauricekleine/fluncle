import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";
import { type UseCurveOptions } from "./use-energy";

/**
 * Near-raw 0..1 kick punch (60-150Hz, transient-emphasized in the pipeline) at
 * the current frame — the strike itself. Default smoothing 1 (no lag): this is
 * a MATERIAL signal (width, threshold, flare on the hit), never motion
 * (Motion law, doctrine 7). Deterministic.
 */
export const useKick = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 1);
};
