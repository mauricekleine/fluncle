import { type RecentTrack } from "./commands/recent";

const COORD_FALLBACK = "—";

/**
 * A finding's coordinate, shown bare (e.g. `007.8.1B`) in tight columns.
 * Falls back to an em dash when a finding predates the Log ID backfill.
 */
export function coordinate(track: Pick<RecentTrack, "logId">): string {
  return track.logId ?? COORD_FALLBACK;
}

/** `Artist, Artist — Title` — the only sanctioned em dash (VOICE.md). */
export function artistTitle(track: Pick<RecentTrack, "artists" | "title">): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

/**
 * Tabular rows led by the Log ID coordinate instead of an ordinal:
 *   007.8.1B  Artist — Title
 * The coordinate column is padded to the widest coordinate in the set.
 */
export function trackRows(tracks: RecentTrack[]): string[] {
  const coordWidth = tracks.reduce((width, track) => {
    return Math.max(width, coordinate(track).length);
  }, 0);

  return tracks.map((track) => {
    return `${coordinate(track).padEnd(coordWidth)}  ${artistTitle(track)}`;
  });
}

/** `3:42` from milliseconds; omitted upstream when duration is unknown. */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Detail lines for a single finding: the coordinate-led header plus the
 * metadata that fits (duration, label). Used by `random` and the `add` result.
 * Stays clean and parseable — `Key: value` per line.
 */
export function trackDetailLines(
  track: Pick<RecentTrack, "artists" | "title" | "logId" | "durationMs" | "label">,
): string[] {
  const lines = [`${coordinate(track)}  ${artistTitle(track)}`];
  const meta: string[] = [];

  if (typeof track.durationMs === "number") {
    meta.push(formatDuration(track.durationMs));
  }

  if (track.label) {
    meta.push(track.label);
  }

  if (meta.length > 0) {
    lines.push(meta.join("  ·  "));
  }

  return lines;
}
