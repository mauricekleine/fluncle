import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";

export type UseCurveOptions = {
  /**
   * Start offset of the curve's timeMs domain relative to frame 0. Defaults to
   * 0, which matches the contract (curves are relative to clip start and the
   * composition starts at clip start).
   */
  startMs?: number;
  /** Smoothing window in frames. Larger = smoother and laggier. */
  smoothingFrames?: number;
};

/**
 * Smoothed 0..1 overall energy at the current frame. Drives the big, slow
 * gestures: starfield drift speed, eclipse glow breadth, global float amplitude.
 * Pure and deterministic.
 */
export const useEnergy = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 4);
};
