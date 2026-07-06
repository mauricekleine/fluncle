import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { accumulateCurveAtFrame } from "./sample-curve";

export type UseAccumulatedOptions = {
  /**
   * Start offset of the curve's timeMs domain relative to frame 0. Defaults to 0
   * (curves are relative to clip start and the composition starts at clip start).
   */
  startMs?: number;
};

/**
 * A HYSTERESIS uniform: the CPU pre-integration of a known audio curve into a leaky
 * integrator ("the world remembers the drop"). Push the result on your own uniform
 * (`u_heat`, `u_wear`, `u_charge`) and the scene carries the drop AFTER it lands —
 * scorch that accumulates, a subject that stays lit past the climax. `decay` ∈ [0, 1):
 * higher = longer memory. Deterministic and frame-pure (safe for headless renders and
 * the multi-tab render model — the answer to GPU feedback, which is foreclosed). Feed
 * it any composition audio.* curve (the same shape the other audio hooks take).
 */
export const useAccumulated = (
  curve: EnergySample[],
  decay: number,
  options: UseAccumulatedOptions = {},
): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return accumulateCurveAtFrame(curve, frame, fps, options.startMs ?? 0, decay);
};
