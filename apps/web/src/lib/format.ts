import { formatDuration, parseDuration } from "@fluncle/contracts/util";

export { formatDuration, parseDuration };

export function formatAlbumDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));

  return `${totalMinutes} min`;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

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

const releaseDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const FULL_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function formatReleaseDate(releaseDate: string): string {
  if (FULL_DAY.test(releaseDate)) {
    return releaseDateFormatter.format(new Date(releaseDate));
  }

  return releaseDate.slice(0, 4) || "—";
}

export function findingsCount(count: number): string {
  return `${count} ${count === 1 ? "finding" : "findings"}`;
}

export function bangersCount(count: number): string {
  return `${count} ${count === 1 ? "banger" : "bangers"}`;
}

export function tracksCount(count: number): string {
  return `${count} ${count === 1 ? "track" : "tracks"}`;
}

export function formatIsoDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `PT${minutes}M${seconds}S`;
}

export function elapsedShort(fromIso: string, nowIso: string): string {
  const ms = new Date(nowIso).getTime() - new Date(fromIso).getTime();

  if (!Number.isFinite(ms) || ms < 60_000) {
    return "moments";
  }

  const minutes = Math.floor(ms / 60_000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
