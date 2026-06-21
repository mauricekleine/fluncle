import { formatDuration } from "@fluncle/contracts/util";
import { type RecentItem, type RecentTrack } from "./commands/recent";

const COORD_FALLBACK = "—";

/**
 * A finding's coordinate, shown bare (e.g. `007.8.1B`) in tight columns.
 * Falls back to an em dash when a finding predates the Log ID backfill.
 */
export function coordinate(track: Pick<RecentItem, "logId">): string {
  return track.logId ?? COORD_FALLBACK;
}

/** `Artist, Artist — Title` — the only sanctioned em dash (VOICE.md). */
export function artistTitle(track: Pick<RecentItem, "artists" | "title">): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

/**
 * The label after the coordinate. A finding reads "Artist — Title". A mixtape
 * reads just its title, with the redundant " | <coord>" suffix stripped — the
 * artist is always Fluncle and the coordinate already leads the line, so the
 * platform title's "Fluncle … | <coord>" would otherwise say both twice.
 */
export function rowLabel(track: Pick<RecentItem, "artists" | "logId" | "title" | "type">): string {
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

/**
 * Tabular rows led by the Log ID coordinate instead of an ordinal:
 *   007.8.1B  Artist — Title
 * The coordinate column is padded to the widest coordinate in the set.
 */
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

/** A finding's "Found" date as `YYYY-MM-DD`, sliced from the ISO `addedAt`. */
export function foundDate(addedAt: string): string {
  return addedAt.slice(0, 10);
}

/**
 * The recent-vehicle ledger, one finding per line:
 *   007.8.1B  2026-06-06  caustic membrane
 * Coordinate column padded to the widest; a finding with no recorded vehicle
 * shows the em-dash fallback.
 */
export function vehicleRows(
  rows: Array<{ addedAt: string; logId?: string; vehicle?: string }>,
): string[] {
  const coordWidth = rows.reduce((width, row) => {
    return Math.max(width, coordinate(row).length);
  }, 0);

  return rows.map((row) => {
    return `${coordinate(row).padEnd(coordWidth)}  ${foundDate(row.addedAt)}  ${row.vehicle ?? COORD_FALLBACK}`;
  });
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
