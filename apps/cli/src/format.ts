import { formatDuration } from "@fluncle/contracts/util";
import { type RecentItem, type RecentTrack } from "./commands/recent";

const COORD_FALLBACK = "—";

export function coordinate(track: Pick<RecentItem, "logId">): string {
  return track.logId ?? COORD_FALLBACK;
}

export function artistTitle(track: Pick<RecentItem, "artists" | "title">): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

function rowLabel(track: Pick<RecentItem, "artists" | "logId" | "title" | "type">): string {
  return track.type === "mixtape"
    ? stripCoordinateSuffix(track.title, track.logId)
    : artistTitle(track);
}

function stripCoordinateSuffix(title: string, logId?: string): string {
  if (!logId) {
    return title;
  }

  const suffix = ` | ${logId}`;

  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trimEnd() : title;
}

export function trackRows(
  tracks: Array<Pick<RecentItem, "artists" | "logId" | "title" | "type">>,
): string[] {
  const coordWidth = tracks.reduce((width, track) => {
    return Math.max(width, coordinate(track).length);
  }, 0);

  return tracks.map((track) => {
    return `${coordinate(track).padEnd(coordWidth)}  ${rowLabel(track)}`;
  });
}

export function foundDate(addedAt: string): string {
  return addedAt.slice(0, 10);
}

export function vehicleRows(
  rows: Array<{ addedAt: string; logId?: string; register?: string; vehicle?: string }>,
): string[] {
  const coordWidth = rows.reduce((width, row) => {
    return Math.max(width, coordinate(row).length);
  }, 0);

  return rows.map((row) => {
    return `${coordinate(row).padEnd(coordWidth)}  ${foundDate(row.addedAt)}  ${row.vehicle ?? COORD_FALLBACK}  ·  ${row.register ?? COORD_FALLBACK}`;
  });
}

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
