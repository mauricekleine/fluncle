export function dueWorkNowIso(now: Date | string): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Due-work evaluation requires a valid now timestamp");
  }
  return date.toISOString();
}
