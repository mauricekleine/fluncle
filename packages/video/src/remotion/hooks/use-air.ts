import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";
import { type UseCurveOptions } from "./use-energy";

/**
 * Smoothed 0..1 air band (>5kHz: hat tails, cymbal wash, hiss) at the current
 * frame. Light default smoothing (sf=2) like useFlux: air is a fast, fine
 * band — sparkle, grain excitement, edge shimmer. Deterministic.
 */
export const useAir = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 2);
};
