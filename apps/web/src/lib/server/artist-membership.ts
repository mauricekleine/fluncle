import { validReleaseDateSql } from "./release-day";

export const ARTIST_JSON_FALLBACK_LIMIT = 5_000;

export function artistCandidateIdsSql(
  artistIdSql: string,
  artistNameSql: string,
  todaySql: string,
): string {
  return `select ta.track_id from track_artists ta
            where ta.artist_id = ${artistIdSql}
          union
          select recent.track_id from (
            select f.track_id from findings f indexed by findings_added_at_track_id_idx
            where f.added_at >= '0000'
            order by f.added_at desc, f.track_id desc limit ${ARTIST_JSON_FALLBACK_LIMIT}
          ) recent
          join tracks t on t.track_id = recent.track_id
          where not exists (select 1 from track_artists edge where edge.track_id = t.track_id)
            and exists (select 1 from json_each(
              case when json_valid(t.artists_json) then t.artists_json else '[]' end) credit
              where lower(credit.value) = lower(${artistNameSql}))
          union
          select future.track_id from (
            select t.track_id from tracks t indexed by tracks_release_date_track_id_idx
            where t.release_date > ${todaySql} and ${validReleaseDateSql("t.release_date")}
            order by t.release_date asc, t.track_id asc limit ${ARTIST_JSON_FALLBACK_LIMIT}
          ) future
          join tracks t on t.track_id = future.track_id
          where not exists (select 1 from track_artists edge where edge.track_id = t.track_id)
            and exists (select 1 from json_each(
              case when json_valid(t.artists_json) then t.artists_json else '[]' end) credit
              where lower(credit.value) = lower(${artistNameSql}))`;
}
