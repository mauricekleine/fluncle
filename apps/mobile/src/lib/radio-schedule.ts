// The radio.fluncle.com shared-clock math, ported from the isomorphic core in
// apps/web/src/lib/radio-schedule.ts. The broadcast is ONE server-authoritative
// loop every listener computes their place in: the server's `/radio/now-playing`
// hands back the current finding + how far into it we are (`offsetMs`) + a stored
// server clock (`serverEpochMs`); the client corrects its own clock (NTP-lite skew)
// and, between polls, decides at each tick whether to hold on the on-screen finding,
// advance to the next, or resync — off the SAME arithmetic the server used. Keeping
// that decision here (pure + dependency-free) is what lets radio-schedule.test.ts pin
// the join/offset/advance logic outside a React screen, the way the web unit test does.
//
// The app plays ONLY the spoken observation over the finding's cover, so the segment
// length IS the observation's duration (the web plays the same audio over a silent
// looping video — the audio is the master clock on both surfaces).

/**
 * A floor on any segment's length (ms). The server's eligibility predicate already
 * excludes a null observation duration, but a corrupt zero / sub-second sliver would
 * make the client thrash. A few seconds sits comfortably below any real observation.
 */
export const SEGMENT_FLOOR_MS = 3000;

/**
 * Hysteresis: commit an advance only once `now` is past the segment's scheduled end
 * by this margin, so a sub-margin overshoot on one client (or a tiny negative skew on
 * another) can't oscillate the surface back to the previous finding at the seam.
 */
export const BOUNDARY_COMMIT_MS = 250;

/**
 * Past the segment end by this much with no advance ⇒ the surface is wedged (a slept
 * screen, a dropped fetch) ⇒ hard-resync to the server rather than sit frozen.
 */
export const SEGMENT_STALE_AFTER_MS = 4000;

/** The floored, real-or-fallback observation length for a finding (ms). */
export function segmentMs(observationDurationMs: number | undefined): number {
  return typeof observationDurationMs === "number" && observationDurationMs >= SEGMENT_FLOOR_MS
    ? Math.round(observationDurationMs)
    : SEGMENT_FLOOR_MS;
}

/** What the schedule-clock controller decides for the on-screen finding each tick. */
export type RadioBoundaryDecision = "advance" | "hold" | "resync";

/**
 * The schedule-clock boundary decision — the source of truth for advancing findings,
 * ported byte-for-byte from the web core so both surfaces agree. The on-screen finding
 * is modelled by its scheduled START in server-clock ms and its (observation) duration;
 * given `now` in the same server clock:
 *
 * - Before the segment even starts (a negative skew overshooting the seam) → resync.
 * - Inside the segment, or within `BOUNDARY_COMMIT_MS` past its end → hold (hysteresis).
 * - Past the end by ≥ commit but < stale → advance (the normal scheduled hand-off).
 * - Past the end by ≥ `SEGMENT_STALE_AFTER_MS` → resync (a wedge; re-ask the server).
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

/**
 * The NTP-lite skew sample (server clock − client clock, ms): the server's epoch at
 * response-build, corrected by half the round-trip, minus the client receive time. A
 * positive result means the server clock reads ahead of this device's `Date.now()`.
 */
export function radioSkewSample(
  serverEpochMs: number,
  sentAtMs: number,
  receivedAtMs: number,
): number {
  return serverEpochMs + (receivedAtMs - sentAtMs) / 2 - receivedAtMs;
}

/**
 * Fold a fresh skew sample into the running skew: the first sample seeds it, later
 * ones ride a light EMA so a single jittery round-trip can't jerk the clock. Matches
 * the web controller's smoothing constant (0.7 old / 0.3 new).
 */
export function smoothSkew(prevSkewMs: number, sampleMs: number): number {
  return prevSkewMs === 0 ? sampleMs : prevSkewMs * 0.7 + sampleMs * 0.3;
}
