import { formatDuration, parseDuration } from "@fluncle/contracts/util";

// `formatDuration`/`parseDuration` are the byte-shared duration helpers — one
// definition each in `@fluncle/contracts/util` (the CLI reads the same).
// Re-exported here so every `@/lib/format` importer keeps its entrypoint.
export { formatDuration, parseDuration };

export function formatAlbumDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));

  return `${totalMinutes} min`;
}

// Pinned locale and timezone so the server-rendered date matches hydration on
// every client; VOICE.md's tabular convention is "Jun 4". Built once at module
// load — the Intl constructor allocates locale-data tables that are expensive to
// rebuild per call.
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

// The archival form with the year ("Jun 4, 2026") — the log page is a permanent
// record, so its Found date carries the year the feed omits.
const dateLongFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

export function formatDateLong(value: string): string {
  return dateLongFormatter.format(new Date(value));
}

export function formatDurationField(durationMs?: number | null): string {
  return durationMs ? formatDuration(durationMs) : "";
}

export function formatIsoDuration(durationMs: number): string {
  // schema.org duration (ISO-8601), e.g. "PT3M37S".
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `PT${minutes}M${seconds}S`;
}
