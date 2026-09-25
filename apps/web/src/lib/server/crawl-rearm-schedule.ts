export type RearmBoundary = {
  hourUtc: number;

  weekday: number;
};

export const SEED_REARM_SCHEDULE: readonly RearmBoundary[] = [
  { hourUtc: 12, weekday: 5 },
  { hourUtc: 0, weekday: 0 },
  { hourUtc: 0, weekday: 2 },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function previousOccurrence(now: number, boundary: RearmBoundary): number {
  const at = new Date(now);
  const dayDelta = (at.getUTCDay() - boundary.weekday + 7) % 7;
  const candidate =
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), boundary.hourUtc) -
    dayDelta * DAY_MS;
  return candidate > now ? candidate - WEEK_MS : candidate;
}

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

let seedRearmClock: () => Date = () => new Date();

export function currentSeedRearmBoundary(): Date {
  return mostRecentSeedRearmBoundary(seedRearmClock());
}

export function setSeedRearmClockForTests(now: Date | null): void {
  seedRearmClock = now === null ? () => new Date() : () => now;
}
