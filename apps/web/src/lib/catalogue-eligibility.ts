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
 * public-catalogue cut. Aliases are deliberately fixed: `t` is tracks and `f` is findings.
 */
export const REC_ELIGIBLE_WHERE = `f.track_id is null
      and t.embedding_blob is not null
      and t.spotify_uri is not null
      and t.dismissed_at is null
      and t.duplicate_of_track_id is null
      and (t.nearest_finding_score is null or t.nearest_finding_score < ${DUPLICATE_SIMILARITY})
      and t.duration_ms < ${LONG_FORM_MS}`;
