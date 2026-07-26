// ── Targeted rank re-staling (docs/the-ear.md § the staleness fingerprint; RFC artist-primary-capture) ──
//
// The Ear's staleness fingerprint (`rankCorpus`, catalogue.ts) folds the QUALIFIED-ARTIST SET SIZE,
// which catches every SECOND-ORDER authorization change: an artist crossing the qualification line
// flips the answer for ALL of their catalogue tracks, so a global re-stale is warranted and the
// fingerprint move is the right tool. It CANNOT catch the FIRST-ORDER change — a single row's OWN
// `track_artists` edges changing while the qualified set stays put (an edge-less catalogue row
// connecting to an ALREADY-qualified artist), or a label ruling's direct effect on its own tracks.
// Those are re-staled here, at their write paths, by nulling `catalogue_rank_corpus` — the same
// "stale" sentinel a brand-new catalogue row is born with, so the next `rank_catalogue` tick
// re-derives the row's tier under the new graph/ruling.
//
// Every statement is guarded by `is_catalogue = 1`: a certified track carries no rank corpus, and
// the guard keeps these writes off certified rows entirely (the sweep only ever ranks catalogue).

/** One statement shape compatible with `db.batch` / `db.execute`. */
type RestaleStatement = { args: string[]; sql: string };

/** The chunk size for an `in (…)` re-stale — bounded so the bind list never approaches SQLite's cap. */
const RESTALE_CHUNK = 200;

/**
 * Null `catalogue_rank_corpus` for the CATALOGUE rows among `trackIds` — the first-order re-stale a
 * `track_artists` edge write owes The Ear. Deduped and chunked; returns `[]` for an empty batch so a
 * caller can spread it into its existing write batch unconditionally.
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
            where is_catalogue = 1 and track_id in (${placeholders})`,
    });
  }

  return statements;
}

/**
 * Null `catalogue_rank_corpus` for every CATALOGUE row on a label — the DIRECT re-stale a label
 * seed-state ruling owes The Ear (`enabled` authorizes its tracks, `disabled` vetoes them). A single
 * bounded, indexed UPDATE riding `tracks_label_id_idx`, NOT a full-table write. `label_id` is the
 * graph-resolved pointer the authorization read (`readArchiveAffinity`) keys on — so a label whose
 * raw string was never resolved to an id touches no rows, exactly as that read would ignore it.
 */
export function restaleCatalogueRankByLabelStatement(labelId: string): RestaleStatement {
  return {
    args: [labelId],
    sql: `update tracks set catalogue_rank_corpus = null
          where is_catalogue = 1 and label_id = ?`,
  };
}
