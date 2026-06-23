// The find-streak: the operator's daily-discovery habit, derived purely from
// findings' `addedAt` timestamps — no DB column, no server round-trip. The streak
// is the run of CONSECUTIVE CALENDAR DAYS, counting most-recent backward, on which
// at least one finding was added. It's "live" only if the most recent find landed
// today or yesterday (a gap of two or more days breaks it back to 0).
//
// Timezone: a "day" is a civil day in Europe/Amsterdam — the operator's timezone
// and the box clock the crons run on — so the boundary between "today" and
// "yesterday" matches when the operator actually experiences midnight, not UTC.
// `addedAt` is an ISO instant; we bucket each instant into its Amsterdam calendar
// date before comparing.

const STREAK_TIME_ZONE = "Europe/Amsterdam";

// en-CA yields ISO-shaped `YYYY-MM-DD`, which sorts and compares as a plain
// string — a stable civil-day key without pulling in a date library.
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: STREAK_TIME_ZONE,
  year: "numeric",
});

/** The Amsterdam civil-day key (`YYYY-MM-DD`) for an instant, or undefined if unparseable. */
function dayKey(instant: Date): string | undefined {
  if (Number.isNaN(instant.getTime())) {
    return undefined;
  }
  return dayKeyFormatter.format(instant);
}

/** Step one civil day back from a `YYYY-MM-DD` key, staying in the same calendar space. */
function previousDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  // Build the date at UTC noon so the arithmetic never trips a DST hour shift; we
  // only ever read the date parts back through the same Amsterdam formatter.
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, 12));
  date.setUTCDate(date.getUTCDate() - 1);
  return dayKeyFormatter.format(date);
}

export type FindStreak = {
  /** Consecutive days (most-recent backward) with at least one find. 0 when broken. */
  days: number;
  /** True when the most recent find landed today or yesterday (the streak is alive). */
  live: boolean;
};

/**
 * Compute the current find-streak from a list of findings (any objects carrying an
 * ISO `addedAt`). `now` is injectable for testing; defaults to the current instant.
 *
 * Note on data: the board loads findings most-recent-first and paginates, so the
 * first page already covers a live streak. A streak longer than the loaded window
 * would read as the loaded length — a floor, never an overstatement — which is the
 * safe direction for a gentle habit nudge.
 */
export function findStreak(
  findings: ReadonlyArray<{ addedAt: string }>,
  now: Date = new Date(),
): FindStreak {
  const today = dayKey(now);
  if (!today) {
    return { days: 0, live: false };
  }

  const found = new Set<string>();
  for (const finding of findings) {
    const key = dayKey(new Date(finding.addedAt));
    if (key) {
      found.add(key);
    }
  }

  const yesterday = previousDayKey(today);

  // Anchor on the most recent qualifying day: today if a find landed today, else
  // yesterday. If neither has a find, the streak is broken (0, not live).
  let cursor: string;
  if (found.has(today)) {
    cursor = today;
  } else if (found.has(yesterday)) {
    cursor = yesterday;
  } else {
    return { days: 0, live: false };
  }

  let days = 0;
  while (found.has(cursor)) {
    days += 1;
    cursor = previousDayKey(cursor);
  }

  return { days, live: true };
}
