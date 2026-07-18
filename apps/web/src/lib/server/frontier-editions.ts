// FRONTIER EDITIONS — the read store + the reusable INSERT builder for a user's
// frozen weekly-refresh snapshots (docs/rfcs/frontier-editions-rfc.md, Unit A1).
//
// ONE LEDGER, READ TWO WAYS. Each real Frontier refresh writes one `frontier_editions`
// parent row + its `frontier_edition_tracks` children (the de-duped PUT order the
// playlist actually sent). That snapshot is both (a) the NOVELTY ledger the engine
// re-derives its exclusion set from (recommendations.ts `excludeRecent`) and (b) the
// HISTORY the "past editions" dropdown/dialog reads for track recovery (Unit B consumes
// the two read functions below).
//
// DELIBERATELY SEPARATE from `frontier-playlist.ts`: Unit A2 edits that file next (it
// folds `frontierEditionInsertStatements` into its `db.batch([...], "write")`), so the
// store lives here to avoid a merge collision. This module NEVER wires itself into the
// mint/refresh flow — it only provides the reusable builder and the reads.

import { type InValue } from "@libsql/client/web";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";

/** One statement in a `db.batch(...)` — the frozen-snapshot inserts A2 folds into its write. */
type SqlStatement = {
  args: InValue[];
  sql: string;
};

/** A frozen edition's summary — one dropdown row and the last-N novelty window's unit. */
export type FrontierEditionSummary = {
  /** Per-user monotonic edition number (the ONE name — column, DTO, path param). */
  number: number;
  /** The edition's `created_at` — when this refresh froze (the date label derives from it). */
  refreshedAt: string;
  /**
   * Seeds whose track had no embedding when this edition froze — named honestly so the
   * shelf can say "these two picks aren't steering yet". `undefined` on a pre-migration
   * edition that cannot back it (the Readout Rule's honest absence).
   */
  seedsSkipped?: string[];
  /** How many seed vectors actually steered this edition. `undefined` pre-migration. */
  seedsUsed?: number;
  /** How many tracks the frozen playlist carried. */
  trackCount: number;
};

/** One frozen track in an edition — everything the dialog renders without a JOIN. */
export type FrontierEditionTrack = {
  artists: string[];
  bpm?: number;
  durationMs?: number;
  /** The frozen cover URL (already a resolved display URL when the snapshot was written). */
  imageUrl?: string;
  key?: string;
  /** Present only for a certified-finding slot; a catalogue row stays coordinate-less. */
  logId?: string;
  /** The frozen max-similarity the engine gave this row. `undefined` pre-migration. */
  similarity?: number;
  slot: "catalogue" | "finding";
  spotifyUrl?: string;
  title: string;
  trackId: string;
};

/** The frozen shape one edition row carries — what A2 hands the insert builder per track. */
export type FrontierEditionTrackInput = {
  artists: string[];
  bpm?: number;
  durationMs?: number;
  imageUrl?: string;
  key?: string;
  logId?: string;
  /** 1-based, the de-duped PUT order. */
  position: number;
  /** The engine's honest max-similarity for the row; omitted freezes as NULL. */
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

/**
 * Parse a frozen `seeds_skipped_json` cell back to a string array. A pre-migration edition
 * stores NULL (→ undefined, the honest absence); a corrupt cell degrades to undefined
 * rather than throwing on a read.
 */
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

/**
 * A user's frontier editions, NEWEST FIRST (`number desc`) — the dropdown's list and
 * the history read. Scoped to the user; the `trackCount` is a grouped count over the
 * child rows so the summary needs no second read.
 */
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

/**
 * One frontier edition + its frozen tracklist, scoped by user_id (NEVER trust the number
 * alone — the number is per-user, so the user_id predicate is what makes it that user's
 * edition). Returns undefined when the user has no edition with that number.
 */
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

/**
 * Build the parent + child INSERT statements for one frozen edition, for A2 to FOLD into
 * its `db.batch([...], "write")` alongside the playlist write (so the edition and the
 * `last_uri_hash` update commit as one atomic unit). This module does NOT execute them —
 * it only assembles the reusable statements.
 *
 * The edition NUMBER is derived INLINE with `coalesce(max(number),0)+1` scoped to the
 * user, so it is monotonic-by-construction inside the batch's transaction (a genuine
 * first mint has `max` = null → 1). `artists_text` is stored as a JSON array (the
 * `getFrontierEdition` read parses it back with `parseArtistsJson`), matching the
 * `mixtape_tracks.artists_text` column type + naming.
 *
 * @param editionId a caller-generated `randomUUID()`, used as the parent id AND the
 *   children's `edition_id` (there is no monotonic id to read back mid-batch).
 *
 * `seedsUsed`/`seedsSkipped` FREEZE the engine's seed accounting onto the parent (both
 * optional — a novelty-only test fixture that does not care about the honesty strings
 * omits them and they store NULL, exactly like a pre-migration row). `similarity` freezes
 * per-row; omitted → NULL.
 */
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
