import { getDb, typedRows } from "./db";

// Admin-board reads for the two audio-observation columns (Context · Observation).
//
// `context_note` is INTERNAL creative fuel: it
// never rides the public `TrackListItem` contract, JSON-LD, RSS, or llms.txt. So
// the board pulls it through this admin-only path instead — a batch presence query
// for the column status, and a single-track text read for the view dialog. Both
// sit behind the same gated admin server functions the rest of the board uses.

/**
 * Which of the given tracks already carry a (non-empty) `context_note`. Returns the
 * trackIds that have one as a Set — the board turns it into the Context cell status.
 * One batch query for the whole page, no N+1.
 */
export async function listContextNotePresenceForTracks(trackIds: string[]): Promise<Set<string>> {
  if (trackIds.length === 0) {
    return new Set();
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id from findings
          where track_id in (${placeholders})
            and context_note is not null and trim(context_note) <> ''`,
  });

  return new Set(typedRows<{ track_id: string }>(result.rows).map((row) => row.track_id));
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
