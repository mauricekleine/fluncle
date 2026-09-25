import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { accumulateCurveAtFrame } from "./sample-curve";

export type UseAccumulatedOptions = {
  startMs?: number;
};

export const useAccumulated = (
  curve: EnergySample[],
  decay: number,
  options: UseAccumulatedOptions = {},
): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return accumulateCurveAtFrame(curve, frame, fps, options.startMs ?? 0, decay);
};
