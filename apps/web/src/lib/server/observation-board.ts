import { getDb, typedRows } from "./db";

// Admin-board batch reads for the per-finding STATUS FLAGS the pipeline board renders —
// the two audio-observation columns (Context · Observation) plus the Discogs / Last.fm /
// Note backfill workflow trackers.
//
// `context_note` is INTERNAL creative fuel and the backfill stamps are internal curation
// state: none ride the public `TrackListItem` contract, JSON-LD, RSS, or llms.txt. So the
// board pulls them through this admin-only path instead — ONE batch flags query for the
// whole page (folded from what used to be five same-id round-trips), plus the single-track
// text reads for the view dialogs. All sit behind the same gated admin server functions the
// rest of the board uses.

/** The per-finding board status flags — one row's worth, all five booleans. */
export type FindingBoardFlags = {
  /** A non-empty internal `context_note` is on file (the Context cell → done). */
  hasContextNote: boolean;
  /** The Discogs backfill has RUN (`backfill_discogs_attempted_at`) — workflow tracker. */
  discogsRan: boolean;
  /** The finding is loved on Last.fm (`backfill_lastfm_done_at`) — refines the Last.fm label. */
  lastfmLoved: boolean;
  /** The Last.fm backfill has RUN (`backfill_lastfm_attempted_at`) — workflow tracker. */
  lastfmRan: boolean;
  /** The auto-note authoring has RUN (`backfill_note_attempted_at`) — workflow tracker. */
  noteRan: boolean;
};

/**
 * Every board status flag for a page of findings, in ONE query keyed by `track_id`. Folds
 * the five reads the board used to fan out over the same 50 ids — the `context_note`
 * presence and the Discogs/Last.fm/Note ran-stamps + the Last.fm loved-stamp — into a single
 * pass over `findings` (each is a bare column predicate on that one row; `track_id` is unique
 * there, so no aggregation). A finding absent from the map (or predating a column) reads all
 * `false`. Bound params only; the ids are never interpolated.
 */
export async function listFindingBoardFlagsForTracks(
  trackIds: string[],
): Promise<Map<string, FindingBoardFlags>> {
  if (trackIds.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id,
            (context_note is not null and trim(context_note) <> '') as has_context_note,
            (backfill_discogs_attempted_at is not null) as discogs_ran,
            (backfill_lastfm_attempted_at is not null) as lastfm_ran,
            (backfill_note_attempted_at is not null) as note_ran,
            (backfill_lastfm_done_at is not null) as lastfm_loved
          from findings
          where track_id in (${placeholders})`,
  });

  const rows = typedRows<{
    track_id: string;
    has_context_note: number;
    discogs_ran: number;
    lastfm_ran: number;
    note_ran: number;
    lastfm_loved: number;
  }>(result.rows);

  return new Map(
    rows.map((row) => [
      row.track_id,
      {
        discogsRan: Boolean(row.discogs_ran),
        hasContextNote: Boolean(row.has_context_note),
        lastfmLoved: Boolean(row.lastfm_loved),
        lastfmRan: Boolean(row.lastfm_ran),
        noteRan: Boolean(row.note_ran),
      },
    ]),
  );
}

/**
 * The internal `context_note` text for one finding — read lazily when the operator
 * opens the Context cell's view dialog (never preloaded for the whole page). Facts
 * fuel only; empty string when absent.
 */
export async function getContextNote(trackId: string): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select context_note from findings where track_id = ? limit 1`,
  });

  const row = typedRows<{ context_note: string | null }>(result.rows)[0];

  return row?.context_note?.trim() ?? "";
}

/**
 * The spoken observation SCRIPT (the transcript) for one finding — read lazily when
 * the operator opens the Observation cell's dialog (never preloaded for the whole
 * page). The script is the transcript mirror of the R2 `observation.json` `text`,
 * stored on the row by the observe render; like `context_note` it's internal, so it
 * stays on this gated admin path and off the public track contract. Empty string
 * when absent (no render yet, or a pre-back-migration finding).
 */
export async function getObservationScript(trackId: string): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select observation_script from findings where track_id = ? limit 1`,
  });

  const row = typedRows<{ observation_script: string | null }>(result.rows)[0];

  return row?.observation_script?.trim() ?? "";
}
