import { type InStatement } from "@libsql/client/web";
import { parseArtistsJson } from "./artists";
import { matchKey, normalizeIsrc } from "./track-match";

export type TrackDuplicateIdentity = {
  artistsJson: string;
  isrc: null | string;
  title: string;
  trackId: string;
};

/** The exact materialized values for one track, through the read path's shared folds. */
export function trackDuplicateKeyValues(identity: TrackDuplicateIdentity): {
  matchKey: string;
  normalizedIsrc: null | string;
} {
  return {
    matchKey: matchKey(parseArtistsJson(identity.artistsJson), identity.title),
    normalizedIsrc: normalizeIsrc(identity.isrc),
  };
}

/**
 * Upsert a track's complete identity projection after an existing row is intentionally re-keyed.
 * The caller places this beside the `tracks` mutation in one `db.batch(_, "write")`.
 */
export function upsertTrackDuplicateKeyStatement(identity: TrackDuplicateIdentity): InStatement {
  const keys = trackDuplicateKeyValues(identity);

  return {
    args: [identity.trackId, keys.matchKey, keys.normalizedIsrc],
    sql: `insert into track_duplicate_keys (track_id, match_key, normalized_isrc)
          values (?, ?, ?)
          on conflict (track_id) do update set
            match_key = excluded.match_key,
            normalized_isrc = excluded.normalized_isrc`,
  };
}

/**
 * Materialize keys beside an `insert into tracks … on conflict do nothing` writer. The SELECT
 * guard is load-bearing: if the track insert lost a PK race or found an older row whose metadata
 * differs, candidate metadata must not overwrite that existing row's derived keys.
 */
export function insertTrackDuplicateKeyStatement(identity: TrackDuplicateIdentity): InStatement {
  const keys = trackDuplicateKeyValues(identity);

  return {
    args: [
      identity.trackId,
      keys.matchKey,
      keys.normalizedIsrc,
      identity.trackId,
      identity.title,
      identity.artistsJson,
      identity.isrc,
    ],
    sql: `insert into track_duplicate_keys (track_id, match_key, normalized_isrc)
          select ?, ?, ?
          from tracks
          where track_id = ? and title = ? and artists_json = ? and isrc is ?
          on conflict (track_id) do update set
            match_key = excluded.match_key,
            normalized_isrc = excluded.normalized_isrc`,
  };
}

/**
 * Move only the ISRC half after a fill-empty identity writer. The equality guard makes a stale
 * pre-write read harmless: if another writer filled a different ISRC first, this statement leaves
 * that writer's projection standing instead of replacing it with the losing candidate.
 */
export function updateTrackDuplicateIsrcStatement(
  trackId: string,
  expectedIsrc: null | string,
): InStatement {
  return {
    args: [normalizeIsrc(expectedIsrc), trackId, trackId, expectedIsrc],
    sql: `update track_duplicate_keys
          set normalized_isrc = ?
          where track_id = ?
            and exists (
              select 1 from tracks
              where tracks.track_id = ? and tracks.isrc is ?
            )`,
  };
}
