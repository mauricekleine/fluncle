/**
 * The cosine-similarity boundary above which a scored catalogue row is a display duplicate
 * rather than a recommendation candidate.
 */
export const DUPLICATE_SIMILARITY = 0.995;

/**
 * The long-form veto: continuous mixes at or above fifteen minutes are not recommendation
 * candidates and never enter the metered capture queue.
 */
export const LONG_FORM_MS = 15 * 60_000;

/**
 * The static recommendation-pool predicate shared by every consumer that needs the anchored
 * public-catalogue cut. Aliases are deliberately fixed: `t` is tracks, `f` is findings, and
 * `emb` is `track_embeddings` — so a consumer must LEFT JOIN all three, and the vector's
 * presence is read as the satellite row's existence rather than off a `tracks` column.
 *
 * That spelling is the CANONICAL one, and the funnel rewrites it onto the stored
 * `has_embedding` mirror at query-construction time (funnel.ts § `onMirrors`) so its stage scan
 * stays covering. Keeping the canonical form here rather than writing the mirror directly is
 * what leaves the fold-equivalence test something real to check the mirror against.
 */
export const REC_ELIGIBLE_WHERE = `f.track_id is null
      and emb.track_id is not null
      and t.spotify_uri is not null
      and t.dismissed_at is null
      and t.duplicate_of_track_id is null
      and (t.nearest_finding_score is null or t.nearest_finding_score < ${DUPLICATE_SIMILARITY})
      and t.duration_ms < ${LONG_FORM_MS}`;
