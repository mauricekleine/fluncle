export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatAlbumDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));

  return `${totalMinutes} min`;
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
      if (minutes >= 60 || seconds >= 60) {
        return null;
      }
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }
    const [minutes, seconds] = nums;
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
