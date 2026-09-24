import { getDb, typedRows } from "./db";
import { validReleaseDateSql } from "./release-day";

export const ARTIST_JSON_FALLBACK_LIMIT = 5_000;

/** Artist membership starts at the edge index; legacy display credits use fixed index windows. */
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

export function renderedArtistCountSql(
  artistIdSql: string,
  artistNameSql: string,
  todaySql: string,
): string {
  return `(select count(*) from (${artistCandidateIdsSql(artistIdSql, artistNameSql, todaySql)}) members
    join tracks t on t.track_id = members.track_id
    left join findings f on f.track_id = t.track_id
    where t.dismissed_at is null and t.duplicate_of_track_id is null
      and (f.track_id is null or f.log_id is not null
        or (t.release_date > ${todaySql} and ${validReleaseDateSql("t.release_date")})))`;
}

export function renderedLabelCountSql(labelIdSql: string, todaySql: string): string {
  return `(select count(*) from tracks t indexed by tracks_label_cover_idx
    left join findings f on f.track_id = t.track_id
    where t.label_id = ${labelIdSql}
      and t.dismissed_at is null and t.duplicate_of_track_id is null
      and (f.log_id is not null
        or (t.release_date > ${todaySql} and ${validReleaseDateSql("t.release_date")})
        or (f.track_id is null and exists (select 1 from json_each(
          case when json_valid(t.artists_json) then t.artists_json else '[]' end)))))`;
}

export async function countRenderedArtistTracks(
  artistId: string,
  artistName: string,
  today: string,
): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [artistId, artistName, today, artistName, today],
    sql: `select ${renderedArtistCountSql("?", "?", "?")} as total`,
  });
  return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
}

export async function countRenderedLabelTracks(labelId: string, today: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [labelId, today],
    sql: `select ${renderedLabelCountSql("?", "?")} as total`,
  });
  return Number(typedRows<{ total: number }>(result.rows)[0]?.total ?? 0);
}

/** One rendered-membership count decides both robots and sitemap membership. */
export function publicEntityIndexable(count: number, floor: number): boolean;
export function publicEntityIndexable(alias: string, floor: number): string;
export function publicEntityIndexable(
  countOrAlias: number | string,
  floor: number,
): boolean | string {
  return typeof countOrAlias === "number"
    ? countOrAlias >= floor
    : `${countOrAlias}.renderable_track_count >= ?`;
}
