const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;

export function clampSnapshotWindow(windowDays?: number): number {
  if (typeof windowDays !== "number" || !Number.isFinite(windowDays) || windowDays <= 0) {
    return DEFAULT_WINDOW_DAYS;
  }

  return Math.min(Math.trunc(windowDays), MAX_WINDOW_DAYS);
}
