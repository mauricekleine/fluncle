export const SEGMENT_FLOOR_MS = 3000;

export const BOUNDARY_COMMIT_MS = 250;

export const SEGMENT_STALE_AFTER_MS = 4000;

export type RadioBoundaryDecision = "advance" | "hold" | "resync";

export function radioBoundaryDecision(
  segmentStartServerMs: number,
  segmentDurationMs: number,
  nowServerMs: number,
): RadioBoundaryDecision {
  const sinceStart = nowServerMs - segmentStartServerMs;

  if (sinceStart < -BOUNDARY_COMMIT_MS) {
    return "resync";
  }

  const pastEnd = sinceStart - segmentDurationMs;

  if (pastEnd < BOUNDARY_COMMIT_MS) {
    return "hold";
  }

  if (pastEnd >= SEGMENT_STALE_AFTER_MS) {
    return "resync";
  }

  return "advance";
}
