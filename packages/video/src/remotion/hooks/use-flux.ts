import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";
import { type UseCurveOptions } from "./use-energy";

/**
 * Continuous 0..1 transient/attack (flux) envelope at the current frame. Between
 * onsets — the shimmer the picture should carry frame-to-frame. Light default
 * smoothing (sf=2): flux is a fast band. Pure and deterministic.
 */
export const useFlux = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 2);
};
