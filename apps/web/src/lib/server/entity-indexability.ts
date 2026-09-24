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

/**
 * Every gate asks one question of this count: does the entity render at least `cap` rows? So the
 * count stops at `cap`. The page, its sitemap entry and the index count read at most `cap` matching
 * rows per entity, however large its catalogue is, instead of walking every row to compare the
 * total with a small floor. `cap` is a module constant, never input; it is inlined as a literal.
 */
function checkedCap(cap: number): number {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`rendered-row cap must be a positive integer, got ${cap}`);
  }

  return cap;
}

function capAt(cap: number): string {
  return `limit ${checkedCap(cap)}`;
}

/** Rendered rows on an artist page: catalogue rows, logged findings, and anything still to come. */
function renderedRowSql(trackAlias: string, findingAlias: string, todaySql: string): string {
  return `${trackAlias}.dismissed_at is null and ${trackAlias}.duplicate_of_track_id is null
      and (${findingAlias}.track_id is null or ${findingAlias}.log_id is not null
        or (${trackAlias}.release_date > ${todaySql} and ${validReleaseDateSql(`${trackAlias}.release_date`)}))`;
}

/**
 * THE ARTIST GATE FOR A WHOLE-ARCHIVE READ (the sitemap rows, their shard boundaries, the index
 * count). The page's membership is the artist's edges plus the credit-name fallback, and the two
 * sets are disjoint (a fallback row has no edge at all), so the rendered count is their sum:
 *
 *   - the EDGE part stays per artist, driven by the `track_artists` index and stopped at `cap`;
 *   - the FALLBACK part does not depend on the artist at all. Its fixed windows (the newest
 *     findings, the next releases) are read ONCE per statement into a materialized table of
 *     credit name → rendered rows, and each artist adds a single lookup by name.
 *
 * Evaluating the fallback per artist instead walks both windows once for every artist in the
 * archive, which is the shape that must never reach a whole-archive read. Prefix the statement
 * with `withArtistFallback(todaySql)` and gate each artist with `renderedArtistGateSql`.
 */
export function withArtistFallback(todaySql: string): string {
  return `with artist_fallback as materialized (
    select lower(credit.value) as name, count(distinct t.track_id) as n
    from (
      select recent.track_id from (
        select f.track_id from findings f indexed by findings_added_at_track_id_idx
        where f.added_at >= '0000'
        order by f.added_at desc, f.track_id desc limit ${ARTIST_JSON_FALLBACK_LIMIT}
      ) recent
      union
      select future.track_id from (
        select t.track_id from tracks t indexed by tracks_release_date_track_id_idx
        where t.release_date > ${todaySql} and ${validReleaseDateSql("t.release_date")}
        order by t.release_date asc, t.track_id asc limit ${ARTIST_JSON_FALLBACK_LIMIT}
      ) future
    ) candidate
    join tracks t on t.track_id = candidate.track_id
    left join findings f on f.track_id = t.track_id
    join json_each(case when json_valid(t.artists_json) then t.artists_json else '[]' end) credit
    where not exists (select 1 from track_artists edge where edge.track_id = t.track_id)
      and ${renderedRowSql("t", "f", todaySql)}
    group by lower(credit.value)
  )`;
}

/**
 * The cheap, indexed necessary condition that runs before the exact gate on a whole-archive read.
 * The maintained `renderable_track_count` counts every edge-linked track (no dismissed/duplicate
 * exclusion), so it is never below the artist's edge-rendered rows; plus the fallback rows by name,
 * it can only rule an artist OUT that the exact gate would also rule out. Only artists that pass it
 * pay for the exact count.
 */
export function artistRenderPrefilterSql(alias: string, cap: number): string {
  return `(${alias}.renderable_track_count + coalesce((select artist_fallback.n from artist_fallback
      where artist_fallback.name = lower(${alias}.name)), 0)) >= ${checkedCap(cap)}`;
}

/** One artist's rendered rows for a whole-archive read (see `withArtistFallback`), up to `cap` on the edge side. */
export function renderedArtistGateSql(
  artistIdSql: string,
  artistNameSql: string,
  todaySql: string,
  cap: number,
): string {
  // `track_artists` is keyed (track_id, artist_id), so an artist's edges never repeat a track and
  // the walk streams straight off the artist index, stopping at `cap`.
  return `((select count(*) from (select 1 from track_artists ta
    join tracks t on t.track_id = ta.track_id
    left join findings f on f.track_id = t.track_id
    where ta.artist_id = ${artistIdSql} and ${renderedRowSql("t", "f", todaySql)}
    ${capAt(cap)}))
    + coalesce((select artist_fallback.n from artist_fallback
        where artist_fallback.name = lower(${artistNameSql})), 0))`;
}

/** The label's rendered rows (released + Upcoming), counted up to `cap`. */
export function renderedLabelCountSql(labelIdSql: string, todaySql: string, cap: number): string {
  return `(select count(*) from (select 1 from tracks t indexed by tracks_label_cover_idx
    left join findings f on f.track_id = t.track_id
    where t.label_id = ${labelIdSql}
      and t.dismissed_at is null and t.duplicate_of_track_id is null
      and (f.log_id is not null
        or (t.release_date > ${todaySql} and ${validReleaseDateSql("t.release_date")})
        or (f.track_id is null and exists (select 1 from json_each(
          case when json_valid(t.artists_json) then t.artists_json else '[]' end))))
    ${capAt(cap)}))`;
}

/**
 * The artist page's robots gate: the SAME predicate the sitemap rows, their shard boundaries and
 * the index count use (the maintained-counter prefilter, then the rendered rows up to `cap`), so the
 * page and the sitemap can never disagree, drifted counter or not.
 */
export async function isArtistIndexable(
  artistId: string,
  today: string,
  cap: number,
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error(`release boundary must be a UTC day, got ${today}`);
  }

  const todaySql = `'${today}'`;
  const db = await getDb();
  const result = await db.execute({
    args: [artistId],
    sql: `${withArtistFallback(todaySql)}
          select (${artistRenderPrefilterSql("a", cap)}
            and ${renderedArtistGateSql("a.id", "a.name", todaySql, cap)} >= ${checkedCap(cap)}) as indexable
          from artists a where a.id = ?`,
  });
  return Number(typedRows<{ indexable: number }>(result.rows)[0]?.indexable ?? 0) === 1;
}

export async function countRenderedLabelTracks(
  labelId: string,
  today: string,
  cap: number,
): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [labelId, today],
    sql: `select ${renderedLabelCountSql("?", "?", cap)} as total`,
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
