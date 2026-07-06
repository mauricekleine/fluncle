import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";
import { type UseCurveOptions } from "./use-energy";

/**
 * Near-raw 0..1 snare crack/presence (2-5kHz, transient-emphasized in the
 * pipeline) at the current frame. Default smoothing 1 (no lag): a MATERIAL
 * signal — map it to a DIFFERENT element than the kick so the backbeat reads
 * (Motion law, doctrine 7). Deterministic.
 */
export const useSnare = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 1);
};
