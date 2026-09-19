// THE RELEASE-WEEK SCHEDULE — when an enabled seed label's subscription comes round again.
//
// A seed label is a subscription (crawl.ts, `rearmSeedLabels`), and the question this module
// answers is only WHEN it is due. The answer is a WEEK SHAPE rather than an interval, because the
// thing being watched has one: drum & bass drops on Friday, and MusicBrainz is editor-entered, so
// a release reaches the graph the crawler walks hours-to-days after it reaches the shops. Three
// passes a week cover that lag without paying for it seven times:
//
//   Friday 12:00 UTC — release-day entries, while the drop is still the week's news.
//   Sunday 00:00 UTC — the weekend's late entries.
//   Tuesday 00:00 UTC — the stragglers an editor got to after the weekend.
//
// The schedule is DATA, not control flow: adding or moving a pass is an edit to one array, and
// every consumer reads the same boundary instant. The hours are UTC by construction — no local
// clock, no zone table, and therefore nothing for a DST shift to move.
//
// WHY A BOUNDARY, NOT A TIMER. A node is due when the most recent boundary at or before `now` is
// NEWER than the node's last drain. That single comparison is self-healing with no special cases:
// a missed pass, a paused crawl, a label enabled mid-week and a node that drained slowly all
// converge on the next boundary, and a node that already drained after the boundary waits for the
// following one. No catch-up backlog, no per-node timer column, no schema.

/** One pass boundary, as a weekday (0 = Sunday, ISO-free `Date.getUTCDay()` numbering) and a UTC hour. */
export type RearmBoundary = {
  /** The UTC hour the pass opens, 0–23. Minutes are always zero. */
  hourUtc: number;
  /** `Date.getUTCDay()` numbering: 0 Sunday … 6 Saturday. */
  weekday: number;
};

/** The ratified release-week passes. All UTC. Order is irrelevant — the most recent one wins. */
export const SEED_REARM_SCHEDULE: readonly RearmBoundary[] = [
  { hourUtc: 12, weekday: 5 },
  { hourUtc: 0, weekday: 0 },
  { hourUtc: 0, weekday: 2 },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * The most recent instant of ONE boundary at or before `now`.
 *
 * Walk back from `now`'s own UTC date to the boundary's weekday, plant the boundary hour there,
 * and step back a whole week when that lands in the future (the boundary's weekday is today but
 * its hour has not struck yet). `now` exactly ON the boundary returns `now`.
 */
function previousOccurrence(now: number, boundary: RearmBoundary): number {
  const at = new Date(now);
  const dayDelta = (at.getUTCDay() - boundary.weekday + 7) % 7;
  const candidate =
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), boundary.hourUtc) -
    dayDelta * DAY_MS;
  return candidate > now ? candidate - WEEK_MS : candidate;
}

/**
 * The most recent pass boundary at or before `now` — the cutoff a `done` seed-label node is
 * measured against. A node drained before this instant is due; one drained at or after it is not.
 */
export function mostRecentSeedRearmBoundary(
  now: Date,
  schedule: readonly RearmBoundary[] = SEED_REARM_SCHEDULE,
): Date {
  const at = now.getTime();
  let latest = Number.NEGATIVE_INFINITY;
  for (const boundary of schedule) {
    const occurrence = previousOccurrence(at, boundary);
    if (occurrence > latest) {
      latest = occurrence;
    }
  }
  return new Date(latest);
}

/**
 * The clock the re-arm reads. Real time in production; a test may point it at a chosen instant so
 * a whole release week can be walked without faking the global clock — which the crawl cannot
 * survive, since its claim measures its wall budget with `Date.now()` and a frozen clock leaves
 * those loops with zero elapsed time forever. Same seam as `setMusicbrainzRateLimitForTests`.
 */
let seedRearmClock: () => Date = () => new Date();

/** The cutoff a `done` seed-label node is measured against right now. */
export function currentSeedRearmBoundary(): Date {
  return mostRecentSeedRearmBoundary(seedRearmClock());
}

/** Point the re-arm's clock at a fixed instant, or pass `null` to restore real time. */
export function setSeedRearmClockForTests(now: Date | null): void {
  seedRearmClock = now === null ? () => new Date() : () => now;
}
