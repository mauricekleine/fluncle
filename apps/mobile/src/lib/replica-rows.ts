// The replica's READ: the one query the archive runs against the local cut, and the mapping
// from its raw SQLite rows to the shape a row component renders. Pure (no expo-sqlite import,
// no RN tree) so the SQL and the mapping are both pinned by tests.
//
// The query lives here rather than beside the native handle for two reasons. It is a
// CONTRACT with the deriving side (apps/web/scripts/lib/device-db-schema.ts decides which
// columns cross the device boundary, and only those are named below), and it has to obey a
// libSQL-mode limit the spike measured: NAMED parameter binding is unsupported, so every
// bound value is positional `?`. A test pins both.
//
// What comes back is a FINDING — a `findings` row that carries a Log ID. The uncertified
// catalogue tracks the anchored cut also ships are deliberately not read here: the archive's
// browse list is Fluncle's findings, and the unnamed tier is never introduced on this
// surface. The galaxy name a live row carries has no column in the cut, so an offline row
// renders its BPM and key and simply says nothing about the galaxy — the meta line drops
// empty fields, which is why nothing has to be invented to fill the gap.

/** How many findings the offline list reads. Deep enough to browse, small enough to be instant. */
export const REPLICA_FINDINGS_LIMIT = 200;

/**
 * The offline browse query: findings newest-first, joined to the track they certify.
 *
 * `findings.added_at` is the Found date and carries the cut's own index
 * (`device_findings_added_at_idx`), so the sort is served rather than computed. The `log_id`
 * filter is the certification test every Fluncle surface uses — a findings row without a
 * coordinate is not something to render. One positional parameter: the limit.
 */
export const REPLICA_FINDINGS_SQL = `select
  f."log_id" as log_id,
  f."added_at" as added_at,
  t."track_id" as track_id,
  t."title" as title,
  t."artists_json" as artists_json,
  t."album_image_url" as album_image_url,
  t."bpm" as bpm,
  t."key" as musical_key
from "findings" f
join "tracks" t on t."track_id" = f."track_id"
where f."log_id" is not null and f."log_id" <> ''
order by f."added_at" desc
limit ?`;

/** A row exactly as SQLite hands it back — every column unknown until it is checked. */
export type ReplicaFindingRow = Record<string, unknown>;

/**
 * A finding as the archive renders it offline. The field names are the ones `ArchiveRow`
 * already takes, so the offline list reuses the shipped row component rather than growing a
 * second one.
 */
export type ReplicaFinding = {
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  key?: string;
  logId: string;
  title: string;
  trackId: string;
};

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  // SQLite hands an INTEGER column back as a number, but a column declared TEXT that holds
  // digits arrives as a string; the cut's `bpm` has crossed both ways historically.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Read `tracks.artists_json` into a name list. Tolerant of everything the column can hold —
 * malformed JSON, a non-array, entries that are not strings — because a single bad row must
 * cost that row and never the whole offline list.
 */
export function parseArtists(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Map one row, or drop it. A row without a coordinate, a track id, or a title cannot be
 * rendered honestly — there would be nothing to name it by and nowhere to send a tap — so it
 * is left out rather than rendered blank.
 */
export function toReplicaFinding(row: ReplicaFindingRow): ReplicaFinding | undefined {
  const logId = readText(row.log_id);
  const trackId = readText(row.track_id);
  const title = readText(row.title);

  if (logId === undefined || trackId === undefined || title === undefined) {
    return undefined;
  }

  const albumImageUrl = readText(row.album_image_url);
  const bpm = readNumber(row.bpm);
  const key = readText(row.musical_key);

  return {
    ...(albumImageUrl === undefined ? {} : { albumImageUrl }),
    artists: parseArtists(row.artists_json),
    ...(bpm === undefined ? {} : { bpm }),
    ...(key === undefined ? {} : { key }),
    logId,
    title,
    trackId,
  };
}

/** Map a result set, dropping the rows that cannot be rendered. Order is preserved. */
export function toReplicaFindings(rows: readonly ReplicaFindingRow[]): ReplicaFinding[] {
  const findings: ReplicaFinding[] = [];
  for (const row of rows) {
    const finding = toReplicaFinding(row);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }
  return findings;
}
