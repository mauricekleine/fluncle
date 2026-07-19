// The bounded day-window shared by the two daily-snapshot series readers — the catalogue
// funnel (funnel.ts) and the platform-stats page (platform-stats.ts). Both surface a season
// of daily snapshots, bounded so the read stays small; one clamp so the bound reads the same
// on both.

/** The default series window — a season of daily snapshots, bounded so the read stays small. */
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;

/** Clamp a requested series window to a sane bounded range (default 90 days, max 365). */
export function clampSnapshotWindow(windowDays?: number): number {
  if (typeof windowDays !== "number" || !Number.isFinite(windowDays) || windowDays <= 0) {
    return DEFAULT_WINDOW_DAYS;
  }

  return Math.min(Math.trunc(windowDays), MAX_WINDOW_DAYS);
}
