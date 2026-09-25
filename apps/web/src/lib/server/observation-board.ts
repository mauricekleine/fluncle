import { getDb, typedRows } from "./db";

export type FindingBoardFlags = {
  hasContextNote: boolean;

  discogsRan: boolean;

  lastfmLoved: boolean;

  lastfmRan: boolean;

  noteRan: boolean;
};

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

export async function getContextNote(trackId: string): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select context_note from findings where track_id = ? limit 1`,
  });

  const row = typedRows<{ context_note: string | null }>(result.rows)[0];

  return row?.context_note?.trim() ?? "";
}

export async function getObservationScript(trackId: string): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select observation_script from findings where track_id = ? limit 1`,
  });

  const row = typedRows<{ observation_script: string | null }>(result.rows)[0];

  return row?.observation_script?.trim() ?? "";
}
