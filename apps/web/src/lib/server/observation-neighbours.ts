// observation-neighbours.ts — the sonic neighbourhood an observation is authored against
// AND the corpus its echo gate measures it against. ONE read, ONE definition of "the
// neighbourhood", so the gate can never judge a script against neighbours the author never
// saw (the note layer's `noteNeighbors` invariant, ported to the spoken family).
//
// The neighbours come from the MuQ audio EMBEDDING (`getSimilarFindings` — an exact cosine
// scan in SQL, the probe bound as a raw blob), never from `features_json`: an observation
// encodes a subjective read of how a finding FEELS on arrival, and two tracks can measure
// nearly identical yet sit nowhere near each other by feel. The embedding is the space the
// neighbours live in.
//
// Every candidate is a certified finding (`getSimilarFindings` drives through the findings
// join), so a catalogue track can never enter the neighbourhood. Only a neighbour that
// already HAS a stored observation script counts — an un-observed one has no register to
// read and no move to spend. Best-effort by design: a finding with no embedding yet, or one
// whose neighbours are all un-observed, comes back `[]` and the observation is authored (and
// gated) exactly as it was before this layer existed.

import { getDb, typedRows } from "./db";
import { type ObservationNeighbor } from "./observation-echo";
import { getSimilarFindings } from "./tracks";

/** The default neighbourhood window — the same six the note layer and `/log`'s "more like this" use. */
export const OBSERVATION_NEIGHBOR_LIMIT = 6;

/**
 * The stored observation scripts of a finding's sonic neighbours, keyed to their Log IDs, in
 * neighbour-nearest order. Reads the ranked neighbours off the embedding, then batch-reads their
 * `observation_script` column in one query. Returns only the neighbours that carry a script.
 */
export async function observationNeighbours(
  trackId: string,
  limit: number = OBSERVATION_NEIGHBOR_LIMIT,
): Promise<ObservationNeighbor[]> {
  const findings = await getSimilarFindings(trackId, limit);
  // Keep only the certified neighbours that carry a Log ID (the coordinate the gate names).
  const ranked = findings.flatMap((finding) =>
    finding.trackId && finding.logId ? [{ logId: finding.logId, trackId: finding.trackId }] : [],
  );

  if (ranked.length === 0) {
    return [];
  }

  // Batch-read the scripts for the neighbour track IDs in ONE query (the script is an internal
  // column, not on the public TrackListItem, so `getSimilarFindings` did not carry it).
  const db = await getDb();
  const placeholders = ranked.map(() => "?").join(", ");
  const result = await db.execute({
    args: ranked.map((neighbor) => neighbor.trackId),
    sql: `select track_id, observation_script from findings
          where track_id in (${placeholders})
            and observation_script is not null and trim(observation_script) != ''`,
  });

  const scriptByTrackId = new Map<string, string>();

  for (const row of typedRows<{ observation_script: string | null; track_id: string }>(
    result.rows,
  )) {
    if (row.observation_script?.trim()) {
      scriptByTrackId.set(row.track_id, row.observation_script.trim());
    }
  }

  // Re-project onto the ranking so the nearest neighbour leads (the map is unordered), keeping
  // only those that had a script.
  return ranked.flatMap((neighbor) => {
    const script = scriptByTrackId.get(neighbor.trackId);

    return script ? [{ logId: neighbor.logId, script }] : [];
  });
}
