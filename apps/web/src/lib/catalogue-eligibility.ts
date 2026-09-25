export const DUPLICATE_SIMILARITY = 0.995;

export const LONG_FORM_MS = 15 * 60_000;

export const REC_ELIGIBLE_WHERE = `f.track_id is null
      and emb.track_id is not null
      and t.spotify_uri is not null
      and t.dismissed_at is null
      and t.duplicate_of_track_id is null
      and (t.nearest_finding_score is null or t.nearest_finding_score < ${DUPLICATE_SIMILARITY})
      and t.duration_ms < ${LONG_FORM_MS}`;
