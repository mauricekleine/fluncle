export const REPLICA_FINDINGS_LIMIT = 200;

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

export type ReplicaFindingRow = Record<string, unknown>;

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

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

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
