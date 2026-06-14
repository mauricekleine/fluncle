import { useCurrentFrame, useVideoConfig } from "remotion";
import { type EnergySample } from "../types";
import { smoothCurveAtFrame } from "./sample-curve";
import { type UseCurveOptions } from "./use-energy";

/**
 * Smoothed 0..1 treble-band energy (>2kHz: hats/cymbals/air) at the current
 * frame. The fastest-moving band — map it to fine, shimmery detail (grain kick,
 * sparkle, edge twinkle) distinct from bass/mid so the scene reads as
 * music-driven. Tighter default smoothing so it stays lively. Deterministic.
 */
export const useTreble = (curve: EnergySample[], options: UseCurveOptions = {}): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return smoothCurveAtFrame(curve, frame, fps, options.startMs ?? 0, options.smoothingFrames ?? 2);
};
