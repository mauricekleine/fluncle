export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatDate(value: string): string {
  // Pinned locale and timezone so the server-rendered date matches hydration
  // on every client; VOICE.md's tabular convention is "Jun 4".
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function formatDateLong(value: string): string {
  // The archival form with the year ("Jun 4, 2026") — the log page is a
  // permanent record, so its Found date carries the year the feed omits.
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

export function formatIsoDuration(durationMs: number): string {
  // schema.org duration (ISO-8601), e.g. "PT3M37S".
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `PT${minutes}M${seconds}S`;
}
