// THE int8 VECTOR-CODE BACKFILL (RFC vector-search-scale, slice A). It fills the compact
// `embedding_f8` / `centroid_f8` COARSE-SCAN codes (lib/server/vector-search.ts) for rows that were
// embedded BEFORE those columns existed — the one-time drain to the state the write path
// (`track-update.ts` / `artist-dossier.ts`) now keeps every NEW embedding in.
//
// It is the simplest sweep in the tree: a pure DB transform, no vendor call, no cooldown, no cursor.
// The worklist IS the anti-set (`embedding_blob is not null and embedding_f8 is null`), so it is
// idempotent and self-draining — a filled row leaves the set, a re-run on a settled archive is a
// no-op, and a crash mid-tick just leaves the rest for the next tick. And the encode happens ENTIRELY
// IN SQL: `vector8(vector_extract(<f32-blob>))` re-quantizes the exact vector the row already holds,
// so NO vector ever crosses into the isolate (docs/local-database.md: never pull a whole vector
// column into the Worker — the same rule that keeps the reads in SQL). Bounded per tick by `limit`
// so one request stays inside the Worker budget; the CLI/cron re-runs until `remaining` is zero.

import { getDb } from "./db";

/** One tick's numbers — what it encoded, and how many rows still need a code (the "run me again" gauge). */
export type VectorCodesBackfillResult = {
  /** `centroid_f8` codes written this tick. */
  centroidsEncoded: number;
  /** `artist_centroids` rows still missing a code — 0 means the centroids are drained. */
  centroidsRemaining: number;
  /** `embedding_f8` codes written this tick. */
  tracksEncoded: number;
  /** Embedded `tracks` rows still missing a code — 0 means the catalogue is drained. */
  tracksRemaining: number;
};

/** Count the rows still needing a code for the given table's `<f32> not null and <f8> null` anti-set. */
async function countRemaining(sql: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql);
  const value = result.rows[0]?.n;

  return typeof value === "number" ? value : Number(value ?? 0);
}

/**
 * Encode up to `limit` un-coded rows in EACH of `tracks` and `artist_centroids`, entirely in SQL.
 * The bound keeps a single request inside the Worker budget; the caller loops until both `remaining`
 * counts are zero. Deterministic + resumable: the batch is the oldest-id slice of the anti-set, so a
 * re-run picks up exactly where it left off.
 */
export async function backfillVectorCodes(limit: number): Promise<VectorCodesBackfillResult> {
  const db = await getDb();
  const bounded = Math.max(1, limit);

  // TRACKS — `vector8(vector_extract(embedding_blob))` re-quantizes the stored float32 in SQL. The
  // inner `limit` bounds the batch; `order by track_id` makes the drain deterministic.
  const trackUpdate = await db.execute({
    args: [bounded],
    sql: `update tracks
          set embedding_f8 = vector8(vector_extract(embedding_blob))
          where track_id in (
            select track_id from tracks
            where embedding_blob is not null and embedding_f8 is null
            order by track_id
            limit ?
          )`,
  });

  // ARTIST CENTROIDS — the `centroid_blob` twin (`.notNull()`, so `vector_extract` is always valid).
  const centroidUpdate = await db.execute({
    args: [bounded],
    sql: `update artist_centroids
          set centroid_f8 = vector8(vector_extract(centroid_blob))
          where artist_id in (
            select artist_id from artist_centroids
            where centroid_f8 is null
            order by artist_id
            limit ?
          )`,
  });

  return {
    centroidsEncoded: centroidUpdate.rowsAffected,
    centroidsRemaining: await countRemaining(
      `select count(*) as n from artist_centroids where centroid_f8 is null`,
    ),
    tracksEncoded: trackUpdate.rowsAffected,
    tracksRemaining: await countRemaining(
      `select count(*) as n from tracks where embedding_blob is not null and embedding_f8 is null`,
    ),
  };
}
