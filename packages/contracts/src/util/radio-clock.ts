/** A floor on any radio segment's length (ms). */
export const SEGMENT_FLOOR_MS = 3000;

/**
 * How long past a segment end the controller waits before advancing (ms). This hysteresis keeps
 * small clock-skew differences from flipping clients back and forth at a seam.
 */
export const BOUNDARY_COMMIT_MS = 250;

/** How far past a segment end a client may drift before it must ask the server again (ms). */
export const SEGMENT_STALE_AFTER_MS = 4000;

/** What the schedule-clock controller decides for the on-screen finding each tick. */
export type RadioBoundaryDecision = "advance" | "hold" | "resync";

/**
 * Decide whether a radio client should hold, advance, or resynchronize. A client resynchronizes
 * before the scheduled start, holds through the segment and commit margin, advances inside the
 * healthy post-boundary window, and resynchronizes once the segment is stale.
 */
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
