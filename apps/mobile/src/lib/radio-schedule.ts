import { SEGMENT_FLOOR_MS } from "@fluncle/contracts/util/radio-clock";

export {
  BOUNDARY_COMMIT_MS,
  type RadioBoundaryDecision,
  radioBoundaryDecision,
  SEGMENT_FLOOR_MS,
  SEGMENT_STALE_AFTER_MS,
} from "@fluncle/contracts/util/radio-clock";

export function segmentMs(observationDurationMs: number | undefined): number {
  return typeof observationDurationMs === "number" && observationDurationMs >= SEGMENT_FLOOR_MS
    ? Math.round(observationDurationMs)
    : SEGMENT_FLOOR_MS;
}

export function radioSkewSample(
  serverEpochMs: number,
  sentAtMs: number,
  receivedAtMs: number,
): number {
  return serverEpochMs + (receivedAtMs - sentAtMs) / 2 - receivedAtMs;
}

export function smoothSkew(prevSkewMs: number, sampleMs: number): number {
  return prevSkewMs === 0 ? sampleMs : prevSkewMs * 0.7 + sampleMs * 0.3;
}
