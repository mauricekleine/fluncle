import { type InStatement } from "@libsql/client/web";
import { parseArtistsJson } from "./artists";
import { matchKey, normalizeIsrc } from "./track-match";

export type TrackDuplicateIdentity = {
  artistsJson: string;
  isrc: null | string;
  title: string;
  trackId: string;
};

export function trackDuplicateKeyValues(identity: TrackDuplicateIdentity): {
  matchKey: string;
  normalizedIsrc: null | string;
} {
  return {
    matchKey: matchKey(parseArtistsJson(identity.artistsJson), identity.title),
    normalizedIsrc: normalizeIsrc(identity.isrc),
  };
}

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
