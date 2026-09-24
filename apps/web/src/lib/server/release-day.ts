/** A release is available from the first UTC day represented by its stored precision. */
export function releaseTodayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Prefix precision includes a period's first day in an indexed lower-bound range. */
export function releaseWindowLowerBound(day: string): string {
  if (!day.endsWith("-01")) {
    return day;
  }
  return day.endsWith("-01-01") ? day.slice(0, 4) : day.slice(0, 7);
}

/** ISO year and month prefixes sort before every full day inside their own period. */
export function isUpcomingRelease(releaseDate: null | string, today: string): boolean {
  return (
    releaseDate !== null && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(releaseDate) && releaseDate > today
  );
}

function validReleaseDateSql(column: string): string {
  return `(${column} glob '[0-9][0-9][0-9][0-9]'
    or ${column} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    or ${column} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`;
}

/** Keep undated tracks in the released lane, as the existing public lists do. */
export function releasedByTodaySql(column: string): string {
  return `(${column} is null or ${column} <= ? or not ${validReleaseDateSql(column)})`;
}

/** For windows that already require a non-null lower release-date bound. */
export function datedReleaseByTodaySql(column: string): string {
  return `${column} <= ?`;
}

export function upcomingAfterTodaySql(column: string): string {
  return `(${column} > ? and ${validReleaseDateSql(column)})`;
}
