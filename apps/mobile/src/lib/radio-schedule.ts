import { SEGMENT_FLOOR_MS } from "@fluncle/contracts/util/radio-clock";

export {
  BOUNDARY_COMMIT_MS,
  type RadioBoundaryDecision,
  radioBoundaryDecision,
  SEGMENT_FLOOR_MS,
  SEGMENT_STALE_AFTER_MS,
} from "@fluncle/contracts/util/radio-clock";

/** The floored, real-or-fallback observation length for a finding (ms). */
export function segmentMs(observationDurationMs: number | undefined): number {
  return typeof observationDurationMs === "number" && observationDurationMs >= SEGMENT_FLOOR_MS
    ? Math.round(observationDurationMs)
    : SEGMENT_FLOOR_MS;
}

/**
 * Estimate server clock skew while accounting for half the request round-trip. A positive result
 * means the server clock is ahead of this device's clock.
 */
export function radioSkewSample(
  serverEpochMs: number,
  sentAtMs: number,
  receivedAtMs: number,
): number {
  return serverEpochMs + (receivedAtMs - sentAtMs) / 2 - receivedAtMs;
}

/**
 * Fold a fresh skew sample into the running skew. Both radio clients use the same 70/30 EMA so a
 * jittery request cannot jerk their shared clock.
 */
export function smoothSkew(prevSkewMs: number, sampleMs: number): number {
  return prevSkewMs === 0 ? sampleMs : prevSkewMs * 0.7 + sampleMs * 0.3;
}
