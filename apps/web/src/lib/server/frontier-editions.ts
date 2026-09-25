import { type InValue } from "@libsql/client/web";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";

type SqlStatement = {
  args: InValue[];
  sql: string;
};

export type FrontierEditionSummary = {
  number: number;

  refreshedAt: string;

  seedsSkipped?: string[];

  seedsUsed?: number;

  trackCount: number;
};

export type FrontierEditionTrack = {
  artists: string[];
  bpm?: number;
  durationMs?: number;

  imageUrl?: string;
  key?: string;

  logId?: string;

  similarity?: number;
  slot: "catalogue" | "finding";
  spotifyUrl?: string;
  title: string;
  trackId: string;
};

export type FrontierEditionTrackInput = {
  artists: string[];
  bpm?: number;
  durationMs?: number;
  imageUrl?: string;
  key?: string;
  logId?: string;

  position: number;

  similarity?: number;
  slot: "catalogue" | "finding";
  spotifyUri?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
};

type SummaryRow = {
  created_at: string;
  number: number;
  seeds_skipped_json: null | string;
  seeds_used: null | number;
  track_count: number;
};

type EditionRow = {
  created_at: string;
  id: string;
  number: number;
  seeds_skipped_json: null | string;
  seeds_used: null | number;
};

type TrackRow = {
  artists_text: string;
  bpm: null | number;
  cover_url: null | string;
  duration_ms: null | number;
  key: null | string;
  log_id: null | string;
  similarity: null | number;
  slot: "catalogue" | "finding";
  spotify_url: null | string;
  title_text: string;
  track_id: string;
};

function parseSeedsSkipped(value: null | string): string[] | undefined {
  if (value === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : undefined;
  } catch {
    return undefined;
  }
}

export async function getFrontierEditions(userId: string): Promise<FrontierEditionSummary[]> {
  const result = await (
    await getDb()
  ).execute({
    args: [userId],
    sql: `select fe.number, fe.created_at, fe.seeds_used, fe.seeds_skipped_json,
        (select count(*) from frontier_edition_tracks fet where fet.edition_id = fe.id) as track_count
      from frontier_editions fe
      where fe.user_id = ?
      order by fe.number desc`,
  });

  return typedRows<SummaryRow>(result.rows).map((row) => ({
    number: row.number,
    refreshedAt: row.created_at,
    seedsSkipped: parseSeedsSkipped(row.seeds_skipped_json),
    seedsUsed: row.seeds_used ?? undefined,
    trackCount: Number(row.track_count),
  }));
}

export async function getFrontierEdition(
  userId: string,
  number: number,
): Promise<undefined | { summary: FrontierEditionSummary; tracks: FrontierEditionTrack[] }> {
  const db = await getDb();
  const editionResult = await db.execute({
    args: [userId, number],
    sql: `select id, number, created_at, seeds_used, seeds_skipped_json
      from frontier_editions
      where user_id = ? and number = ?
      limit 1`,
  });
  const edition = typedRow<EditionRow>(editionResult.rows);

  if (!edition) {
    return undefined;
  }

  const trackResult = await db.execute({
    args: [edition.id],
    sql: `select track_id, log_id, title_text, artists_text, cover_url, spotify_url,
        bpm, key, duration_ms, similarity, slot
      from frontier_edition_tracks
      where edition_id = ?
      order by position asc`,
  });
  const tracks = typedRows<TrackRow>(trackResult.rows).map(
    (row): FrontierEditionTrack => ({
      artists: parseArtistsJson(row.artists_text),
      bpm: row.bpm ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      imageUrl: row.cover_url ?? undefined,
      key: row.key ?? undefined,
      logId: row.log_id ?? undefined,
      similarity: row.similarity ?? undefined,
      slot: row.slot,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title_text,
      trackId: row.track_id,
    }),
  );

  return {
    summary: {
      number: edition.number,
      refreshedAt: edition.created_at,
      seedsSkipped: parseSeedsSkipped(edition.seeds_skipped_json),
      seedsUsed: edition.seeds_used ?? undefined,
      trackCount: tracks.length,
    },
    tracks,
  };
}

export function frontierEditionInsertStatements(params: {
  createdAt: string;
  editionId: string;
  seedsSkipped?: string[];
  seedsUsed?: number;
  tracks: FrontierEditionTrackInput[];
  userId: string;
}): SqlStatement[] {
  const { createdAt, editionId, seedsSkipped, seedsUsed, tracks, userId } = params;

  const parent: SqlStatement = {
    args: [
      editionId,
      userId,
      userId,
      createdAt,
      seedsUsed ?? null,
      seedsSkipped ? JSON.stringify(seedsSkipped) : null,
    ],
    sql: `insert into frontier_editions (id, user_id, number, created_at, seeds_used, seeds_skipped_json)
      values (?, ?, (select coalesce(max(number), 0) + 1 from frontier_editions where user_id = ?), ?, ?, ?)`,
  };

  const children: SqlStatement[] = tracks.map((track) => ({
    args: [
      editionId,
      track.position,
      track.trackId,
      track.logId ?? null,
      track.title,
      JSON.stringify(track.artists),
      track.imageUrl ?? null,
      track.spotifyUri ?? null,
      track.spotifyUrl ?? null,
      track.bpm ?? null,
      track.key ?? null,
      track.durationMs ?? null,
      track.similarity ?? null,
      track.slot,
    ],
    sql: `insert into frontier_edition_tracks
        (edition_id, position, track_id, log_id, title_text, artists_text, cover_url,
         spotify_uri, spotify_url, bpm, key, duration_ms, similarity, slot)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  }));

  return [parent, ...children];
}
