import { formatDuration } from "@fluncle/contracts/util";

// `formatDuration` is the byte-shared M:SS formatter — one definition in
// `@fluncle/contracts/util` (the CLI reads the same). Re-exported here so every
// `@/lib/format` importer keeps its entrypoint.
export { formatDuration };

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

export function parseDuration(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts.length !== 2 && parts.length !== 3) {
      return null;
    }
    const nums = parts.map((part) => Number(part));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      return null;
    }
    if (parts.length === 3) {
      const [hours, minutes, seconds] = nums;
      if (hours === undefined || minutes === undefined || seconds === undefined) {
        return null;
      }
      if (minutes >= 60 || seconds >= 60) {
        return null;
      }
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }
    const [minutes, seconds] = nums;
    if (minutes === undefined || seconds === undefined) {
      return null;
    }
    if (seconds >= 60) {
      return null;
    }
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatIsoDuration(durationMs: number): string {
  // schema.org duration (ISO-8601), e.g. "PT3M37S".
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `PT${minutes}M${seconds}S`;
}
