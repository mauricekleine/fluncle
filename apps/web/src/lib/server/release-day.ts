export const FRESH_WINDOW_DAYS = 30;

export function releaseTodayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function releaseWindowLowerBound(day: string): string {
  if (!day.endsWith("-01")) {
    return day;
  }
  return day.endsWith("-01-01") ? day.slice(0, 4) : day.slice(0, 7);
}

export function isUpcomingRelease(releaseDate: null | string, today: string): boolean {
  return (
    releaseDate !== null && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(releaseDate) && releaseDate > today
  );
}

export function validReleaseDateSql(column: string): string {
  return `(${column} glob '[0-9][0-9][0-9][0-9]'
    or ${column} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    or ${column} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`;
}

export function releasedByTodaySql(column: string): string {
  return `(${column} is null or ${column} <= ? or not ${validReleaseDateSql(column)})`;
}

export function datedReleaseByTodaySql(column: string): string {
  return `${column} <= ?`;
}

export function upcomingAfterTodaySql(column: string): string {
  return `(${column} > ? and ${validReleaseDateSql(column)})`;
}
