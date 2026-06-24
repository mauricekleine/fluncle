// The find-streak: the operator's daily publishing ritual, derived purely from the
// day's published social posts — no DB column, one set-of-(platform, published_at)
// read. The meaningful daily habit isn't *adding* a finding, it's PUBLISHING the
// day's video to BOTH platforms — so a calendar day only "counts" when it carries at
// least one published YouTube post AND at least one published TikTok post. The streak
// is the run of CONSECUTIVE CALENDAR DAYS, counting most-recent backward, on which
// both happened. It's "live" only if the most recent qualifying day is today or
// yesterday (a gap of two or more days breaks it back to 0).
//
// Timezone: a "day" is a civil day in Europe/Amsterdam — the operator's timezone
// and the box clock the crons run on — so the boundary between "today" and
// "yesterday" matches when the operator actually experiences midnight, not UTC.
// `publishedAt` is an ISO instant; we bucket each instant into its Amsterdam
// calendar date before comparing.

const STREAK_TIME_ZONE = "Europe/Amsterdam";

// The two platforms that must both land on a day for it to count. A day qualifies
// only when it carries ≥1 published post on EACH.
const REQUIRED_PLATFORMS = ["youtube", "tiktok"] as const;
type RequiredPlatform = (typeof REQUIRED_PLATFORMS)[number];

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

/** A published social post, narrowed to the two fields the streak reads. */
export type PublishedPost = {
  /** The platform slug — only `"youtube"` / `"tiktok"` count toward the streak. */
  platform: string;
  /** ISO instant the post went live, bucketed into an Amsterdam civil day. */
  publishedAt?: string;
  /** Post lifecycle — only `"published"` counts. */
  status: string;
};

export type FindStreak = {
  /** Consecutive both-platforms-published days (most-recent backward). 0 when broken. */
  days: number;
  /** True when the most recent qualifying day is today or yesterday (the streak is alive). */
  live: boolean;
};

/**
 * Compute the current publish-streak from the day's social posts (any objects
 * carrying `platform`, `status`, and an ISO `publishedAt`). A calendar day qualifies
 * only when it carries at least one published YouTube post AND at least one published
 * TikTok post — both, or the day doesn't count. `now` is injectable for testing;
 * defaults to the current instant.
 *
 * Note on data: this reads the full set of published posts (server-side, not the
 * paginated board window), so the streak is exact, not a floor.
 */
export function findStreak(
  posts: ReadonlyArray<PublishedPost>,
  now: Date = new Date(),
): FindStreak {
  const today = dayKey(now);
  if (!today) {
    return { days: 0, live: false };
  }

  // For each civil day, track which required platforms published. A day qualifies
  // once its set holds BOTH platforms.
  const byDay = new Map<string, Set<RequiredPlatform>>();
  for (const post of posts) {
    if (post.status !== "published" || !post.publishedAt) {
      continue;
    }
    const platform = REQUIRED_PLATFORMS.find((p) => p === post.platform);
    if (!platform) {
      continue;
    }
    const key = dayKey(new Date(post.publishedAt));
    if (!key) {
      continue;
    }
    const set = byDay.get(key) ?? new Set<RequiredPlatform>();
    set.add(platform);
    byDay.set(key, set);
  }

  const qualifies = (key: string): boolean => {
    const set = byDay.get(key);
    return set !== undefined && REQUIRED_PLATFORMS.every((p) => set.has(p));
  };

  const yesterday = previousDayKey(today);

  // Anchor on the most recent qualifying day: today if both platforms published
  // today, else yesterday. If neither qualifies, the streak is broken (0, not live).
  let cursor: string;
  if (qualifies(today)) {
    cursor = today;
  } else if (qualifies(yesterday)) {
    cursor = yesterday;
  } else {
    return { days: 0, live: false };
  }

  let days = 0;
  while (qualifies(cursor)) {
    days += 1;
    cursor = previousDayKey(cursor);
  }

  return { days, live: true };
}
