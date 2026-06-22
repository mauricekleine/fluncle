// The radio.fluncle.com shared-clock math (RFC radio-broadcast.md, Unit A).
//
// The broadcast is a PURE FUNCTION of `(deterministic eligible list, per-segment
// duration, one stored epoch)` — there is no clock to run, only a clock to
// COMPUTE. "What's playing now and at what offset" is `p = (now − epoch) mod T`,
// then a cumulative-duration walk to the index and the residual offset. The
// SERVER computes it to build the `now-playing` response; the CLIENT computes the
// IDENTICAL math between polls (off `Date.now() + skew`). Keeping the arithmetic
// in one isomorphic, dependency-free module is what makes those two agree.
//
// `radio-schedule.test.ts` is the load-bearing unit test (empty / single / floor
// / growth-at-boundary), so this stays a pure function with no DB or env access.

/**
 * A radio-eligible finding's place in the loop: the trackId/logId the URL builder
 * needs and the segment length that drives the clock. The audio is the master
 * clock — the segment length is exactly the observation's duration.
 */
export type RadioScheduleEntry = {
  logId: string;
  observationDurationMs: number;
  trackId: string;
};

/**
 * A floor on any segment's length. The eligibility predicate already excludes a
 * null `observation_duration_ms`, but a corrupt zero (or a sub-second sliver)
 * would produce a zero/near-zero-width slot that breaks the cumulative walk and
 * makes the client thrash through segments. A few seconds is comfortably below
 * any real observation, so it only ever guards garbage.
 */
export const SEGMENT_FLOOR_MS = 3000;

/**
 * The offset-snap grid (RFC Decision #4 / §3.3). A fresh joiner's offset is
 * snapped DOWN to this grid before fetching the join clip, so per-second offsets
 * don't fragment the 20-day edge cache into a cold `MISS` per joiner — they share
 * a handful of warm clips per segment. The ≤grid residual is nudged with
 * `<video>/<audio>.currentTime` inside the small faststart clip (cheap).
 */
export const OFFSET_SNAP_GRID_MS = 10_000;

/** The clamped, floor-guarded length of one segment. */
export function segmentDurationMs(entry: RadioScheduleEntry): number {
  const raw = entry.observationDurationMs;

  if (!Number.isFinite(raw) || raw < SEGMENT_FLOOR_MS) {
    return SEGMENT_FLOOR_MS;
  }

  return Math.round(raw);
}

/** The total loop length `T = Σ dᵢ` (ms). Zero for an empty schedule. */
export function totalLoopDurationMs(entries: readonly RadioScheduleEntry[]): number {
  let total = 0;

  for (const entry of entries) {
    total += segmentDurationMs(entry);
  }

  return total;
}

/** The current slot the shared clock resolves to. */
export type RadioSlot = {
  /** ms into `current`'s observation (0 ≤ offsetMs < this segment's duration). */
  currentDurationMs: number;
  currentIndex: number;
  current: RadioScheduleEntry;
  /** The preload target — always starts at offset 0 (the scheduled transition). */
  next: RadioScheduleEntry;
  nextIndex: number;
  offsetMs: number;
};

/**
 * Resolve `(epoch, now)` to the slot playing right now on the shared loop.
 *
 * `p = (now − epoch) mod T` is the position within one loop; a cumulative-duration
 * walk finds the index `k` where `Cₖ ≤ p < Cₖ₊₁`, and `offsetMs = p − Cₖ`. The
 * walk is `O(n)` over the eligible set — fine at this catalogue scale, and the
 * same on the server and the client.
 *
 * `now − epoch` is taken modulo `T` with a floored modulo so a `now` BEFORE the
 * epoch (a skewed client clock, a freshly-rolled future epoch) still lands inside
 * the loop instead of going negative. Returns `undefined` for an empty schedule
 * (the caller surfaces the empty-sector state — never a divide-by-T).
 */
export function resolveRadioSlot(
  entries: readonly RadioScheduleEntry[],
  epochMs: number,
  nowMs: number,
): RadioSlot | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const total = totalLoopDurationMs(entries);

  // Floored modulo: ((now − epoch) % T + T) % T stays in [0, T) for any sign.
  const elapsed = nowMs - epochMs;
  const p = ((elapsed % total) + total) % total;

  let cumulative = 0;
  let index = entries.length - 1;
  let offsetMs = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (!entry) {
      continue;
    }

    const duration = segmentDurationMs(entry);

    if (p < cumulative + duration) {
      index = i;
      offsetMs = p - cumulative;
      break;
    }

    cumulative += duration;
  }

  const nextIndex = (index + 1) % entries.length;
  const current = entries[index];
  const next = entries[nextIndex];

  // `entries.length > 0` and both indices are in-bounds by construction, so this
  // guard never fires — but it discharges noUncheckedIndexedAccess honestly and
  // keeps the empty-schedule contract (caller surfaces the empty-sector state).
  if (!current || !next) {
    return undefined;
  }

  return {
    current,
    currentDurationMs: segmentDurationMs(current),
    currentIndex: index,
    next,
    nextIndex,
    offsetMs,
  };
}

/**
 * Roll an epoch forward to the NEXT loop boundary at or after `now`, so a NEW
 * schedule (a grown / re-observed eligible set, with a different `T`) takes effect
 * only at a seam — no current listener's playhead jumps mid-loop.
 *
 * `epoch' = epoch + ⌈(now − epoch) / Tₒₗₐ⌉ · Tₒₗₐ`, computed against the OLD loop
 * length the current listeners are still riding. The new schedule then measures
 * its own `T` from `epoch'`. When the old epoch is already at/after `now` (a fresh
 * anchor), it is returned unchanged. `Tₒₗₐ ≤ 0` (the schedule was empty) has no
 * boundary to align to, so `now` becomes the fresh anchor.
 */
export function nextBoundaryEpochMs(
  currentEpochMs: number,
  oldLoopDurationMs: number,
  nowMs: number,
): number {
  if (oldLoopDurationMs <= 0) {
    return nowMs;
  }

  const elapsed = nowMs - currentEpochMs;

  if (elapsed <= 0) {
    return currentEpochMs;
  }

  const loopsToBoundary = Math.ceil(elapsed / oldLoopDurationMs);

  return currentEpochMs + loopsToBoundary * oldLoopDurationMs;
}

/**
 * The breather between findings (Feature B): a short fade-out → dark hold →
 * fade-in across each segment boundary. It is timed PURELY off the shared
 * segment-start anchor (Bug A's clock, untouched) and straddles the seam
 * SYMMETRICALLY, so it adds ZERO net time to the timeline — the audio still
 * advances at the true server boundary, and every client darkens and lifts at the
 * same shared-clock instants. That is what keeps it synchronized without changing
 * the proven server loop: the fade is a function of the segment offset, not a
 * per-client animation that could drift.
 *
 * The dark "hold" is centered on the boundary: the ending clip fades over
 * BREATHER_FADE_OUT_MS BEFORE its observation ends, black holds across the seam,
 * the new clip fades in over BREATHER_FADE_IN_MS AFTER it starts. Kept short and
 * well under SEGMENT_FLOOR_MS so even a floored 3s segment is never wholly eaten by
 * the fade.
 */
export const BREATHER_FADE_OUT_MS = 900;
export const BREATHER_FADE_IN_MS = 900;

/** The whole visible darkening window around one seam (fade-out + fade-in). */
export const BREATHER_TOTAL_MS = BREATHER_FADE_OUT_MS + BREATHER_FADE_IN_MS;

/**
 * The 0→1 dim level of the breather overlay at a given offset into the on-screen
 * observation, derived ONLY from the shared segment-start anchor — so it is
 * identical on every client at the same shared-clock instant. Ramps up to 1 (full
 * black) over the final BREATHER_FADE_OUT_MS of the observation, then (because the
 * next segment starts at offset 0) the new segment's small-offset region ramps it
 * back down over BREATHER_FADE_IN_MS. Returns 0 in the calm middle of a segment.
 *
 * `segmentDurationMs` is the observation length (the real audio boundary). Reduced
 * motion bypasses this entirely (an instant cut), but since the cut still lands at
 * the same shared boundary, a reduced-motion client stays in lockstep with an
 * animated one.
 */
export function breatherDimAt(offsetMs: number, segmentDurationMs: number): number {
  // Fade IN of the NEW segment: the first BREATHER_FADE_IN_MS lift black → clear.
  if (offsetMs < BREATHER_FADE_IN_MS) {
    return clamp01(1 - offsetMs / BREATHER_FADE_IN_MS);
  }

  // Fade OUT of the ENDING segment: the final BREATHER_FADE_OUT_MS sink clear → black.
  const untilEnd = segmentDurationMs - offsetMs;

  if (untilEnd < BREATHER_FADE_OUT_MS) {
    return clamp01(1 - Math.max(0, untilEnd) / BREATHER_FADE_OUT_MS);
  }

  return 0;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }

  return value > 1 ? 1 : value;
}

/**
 * How long after a segment's scheduled END the controller waits before COMMITTING
 * the advance to the next finding (Bug A hysteresis). The seam is the one place
 * clock skew + rounding can flip the resolved index between N and N+1; committing
 * only once `now` is past the end by this margin means a sub-margin overshoot on
 * one client (or a tiny negative skew on another) can't oscillate the surface back
 * to the previous finding. Kept small so the audio swap still lands inside the dark
 * hold (under cover of the fade).
 */
export const BOUNDARY_COMMIT_MS = 250;

/**
 * How far past a segment's scheduled END the on-screen finding may be before the
 * controller treats it as STALE and re-asks the server (Bug A self-heal). A healthy
 * client advances at the boundary; a wedged one (a missed `ended`, a slept tab, a
 * dropped preload) sits frozen while the shared clock moves on. Once the on-screen
 * segment is this far past its end with no committed advance, the watchdog hard-
 * resyncs — no manual refresh.
 */
export const SEGMENT_STALE_AFTER_MS = 4000;

/** What the schedule-clock controller decides on each tick for the on-screen finding. */
export type RadioBoundaryDecision = "advance" | "hold" | "resync";

/**
 * The schedule-clock-driven boundary decision — the source of truth for advancing
 * findings (Bug A root-cause fix). The on-screen finding is modelled by its
 * scheduled START in server-clock ms and its (observation) duration. Given `now` in
 * the same server clock, decide whether to hold, advance to the preloaded next
 * finding, or resync to the server.
 *
 * - Before the segment even starts (a negative skew correction overshooting the
 *   seam) → resync (don't advance off a segment that isn't current).
 * - Inside the segment, or within BOUNDARY_COMMIT_MS past its end → hold (the
 *   hysteresis band: the seam can't flip back to the previous finding, and a tiny
 *   overshoot rides instead of advancing).
 * - Past the end by ≥ BOUNDARY_COMMIT_MS but < SEGMENT_STALE_AFTER_MS → advance
 *   (the normal scheduled hand-off).
 * - Past the end by ≥ SEGMENT_STALE_AFTER_MS → resync (a wedge: the advance never
 *   happened, the surface is frozen, re-ask the server).
 *
 * Pure and isomorphic-friendly so it is unit-tested in isolation (the load-bearing
 * advance logic must not live only inside a React effect).
 */
export function radioBoundaryDecision(
  segmentStartServerMs: number,
  segmentDurationMs: number,
  nowServerMs: number,
): RadioBoundaryDecision {
  const sinceStart = nowServerMs - segmentStartServerMs;

  // The on-screen segment hasn't started yet (only reachable via a clock-skew
  // overshoot) — don't advance off a segment that isn't current; re-ask the server.
  if (sinceStart < -BOUNDARY_COMMIT_MS) {
    return "resync";
  }

  const pastEnd = sinceStart - segmentDurationMs;

  // Still inside the segment, or only a hair past the end → hold (hysteresis: no flip).
  if (pastEnd < BOUNDARY_COMMIT_MS) {
    return "hold";
  }

  // Far past the end with no advance → the surface is wedged; re-ask the server.
  if (pastEnd >= SEGMENT_STALE_AFTER_MS) {
    return "resync";
  }

  // Past the end, within the healthy window → the normal scheduled advance.
  return "advance";
}

/**
 * Snap a join offset DOWN to the cache-sharing grid (§3.3). The ≤grid residual is
 * nudged via `currentTime` inside the small faststart clip — so joiners within
 * the same grid cell share one warm edge-cached clip instead of minting a cold
 * per-second transform each.
 */
export function snapOffsetMs(offsetMs: number, gridMs: number = OFFSET_SNAP_GRID_MS): number {
  if (gridMs <= 0) {
    return Math.max(0, Math.floor(offsetMs));
  }

  return Math.max(0, Math.floor(offsetMs / gridMs) * gridMs);
}
