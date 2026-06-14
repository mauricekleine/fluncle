import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";
import { type UseCurveOptions } from "./use-energy";

/**
 * Smoothed 0..1 mid-band energy (150Hz-2kHz: lead/vocal/snare body) at the
 * current frame. Map it to a DIFFERENT element than bass/treble so the scene
 * reads as music-driven (the kick moves one thing, the lead another). Tighter
 * default smoothing than useEnergy so it follows the melody. Deterministic.
 */
export const useMid = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 3);
};
