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
    const duration = segmentDurationMs(entries[i]);

    if (p < cumulative + duration) {
      index = i;
      offsetMs = p - cumulative;
      break;
    }

    cumulative += duration;
  }

  const nextIndex = (index + 1) % entries.length;

  return {
    current: entries[index],
    currentDurationMs: segmentDurationMs(entries[index]),
    currentIndex: index,
    next: entries[nextIndex],
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
