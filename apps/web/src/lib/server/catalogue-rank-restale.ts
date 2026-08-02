// ── Targeted rank re-staling (docs/the-ear.md § the staleness fingerprint; RFC artist-primary-capture) ──
//
// The Ear's staleness fingerprint (`rankCorpus`, catalogue.ts) folds the QUALIFIED-ARTIST SET (its
// size + a digest), which catches every SECOND-ORDER authorization change: an artist crossing the
// qualification line flips the answer for ALL of their catalogue tracks, so a global re-stale is
// warranted and the fingerprint move is the right tool. It CANNOT catch the FIRST-ORDER change — a
// single row's OWN `track_artists` edges changing while the qualified set stays put (an edge-less
// catalogue row connecting to an ALREADY-qualified artist), or a label ruling's direct effect on its
// own tracks. Those are re-staled here, at their write paths, by nulling `catalogue_rank_corpus` —
// the same "stale" sentinel a brand-new catalogue row is born with, so the next `rank_catalogue` tick
// re-derives the row's tier under the new graph/ruling.
//
// ── WHY NO `is_catalogue = 1` GUARD, THOUGH THAT IS THE ROW SET WE MEAN ─────────────────────────────
// The obvious predicate is `where is_catalogue = 1 and <selective key>`. It is a TRAP: with no
// `sqlite_stat1` on hosted Turso the planner picks `tracks_is_catalogue_idx` (which matches ~every
// catalogue row) over the far more selective key, turning each restale into a FULL catalogue scan —
// On a 65k-row scratch DB this costs 9.6 s (2.6k-track label) / 18.5 s (13k-track
// label) per ruling, and O(catalogue) as it grows: exactly the churn this change removes, moved onto
// the ruling path. Dropping the guard lets the planner seek the SELECTIVE key instead — the `tracks`
// PRIMARY KEY for the per-track form (measured 50 ms / 200-id chunk, plan `SEARCH … sqlite_autoindex_tracks_1`)
// and `tracks_label_id_idx` for the per-label form (77 ms / 2.6k, 129 ms / 13k, plan `SEARCH … tracks_label_id_idx`),
// both bounded by the touched rows, never the catalogue. Nulling `catalogue_rank_corpus` on a row that
// is NOT catalogue is a harmless no-op: only the sweep ever writes that column and only for
// `is_catalogue = 1` rows (so a certified row's value is already null), and every reader
// (`rankCatalogue`, `computeCatalogueCounts`) filters `is_catalogue = 1`, so the value is never read
// on a certified row regardless. Correctness comes from the selective key; the row-kind is incidental.

/** One statement shape compatible with `db.batch` / `db.execute`. */
type RestaleStatement = { args: string[]; sql: string };

/** The chunk size for an `in (…)` re-stale — bounded so the bind list never approaches SQLite's cap. */
const RESTALE_CHUNK = 200;

/**
 * Null `catalogue_rank_corpus` for the given `trackIds` — the first-order re-stale a `track_artists`
 * edge write owes The Ear. Seeks by PRIMARY KEY (see the guard note above); deduped and chunked;
 * returns `[]` for an empty batch so a caller can spread it into its existing write batch unconditionally.
 */
export function restaleCatalogueRankStatements(trackIds: readonly string[]): RestaleStatement[] {
  const unique = [...new Set(trackIds)];

  if (unique.length === 0) {
    return [];
  }

  const statements: RestaleStatement[] = [];

  for (let i = 0; i < unique.length; i += RESTALE_CHUNK) {
    const chunk = unique.slice(i, i + RESTALE_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");

    statements.push({
      args: chunk,
      sql: `update tracks set catalogue_rank_corpus = null
            where track_id in (${placeholders})`,
    });
  }

  return statements;
}

/**
 * Null `catalogue_rank_corpus` for every row on a label — the DIRECT re-stale a label seed-state
 * ruling owes The Ear (`enabled` authorizes its tracks, `disabled` vetoes them). A single bounded
 * UPDATE that seeks `tracks_label_id_idx` (see the guard note above), never a full-table scan.
 * `label_id` is the graph-resolved pointer the authorization read (`readArchiveAffinity`) keys on —
 * so a label whose raw string was never resolved to an id touches no rows, exactly as that read
 * would ignore it.
 */
export function restaleCatalogueRankByLabelStatement(labelId: string): RestaleStatement {
  return {
    args: [labelId],
    sql: `update tracks set catalogue_rank_corpus = null
          where label_id = ?`,
  };
}
