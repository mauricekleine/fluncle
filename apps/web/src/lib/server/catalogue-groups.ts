import { type Client } from "@libsql/client";
import {
  type CatalogueArtistGroup,
  type CatalogueGroupPage,
  CataloguePageOutOfRangeError,
  type CatalogueRecord,
  type CatalogueSort,
  type UpcomingTrackPage,
  flattenArtistGroups,
  flattenRecords,
  GRAPH_GROUP_PAGE_SIZE,
  GRAPH_GROUP_ROW_CEILING,
  GRAPH_GROUP_TRACK_LIMIT,
} from "../catalogue";
import { parseArtistsJson } from "./artists";
import { bestAlbumCoverUrl } from "../media";
import { hasPreviewSource } from "../track-preview";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import { dedupeByRecordingIdentity, type RecordingIdentity } from "./track-match";
import { type CatalogueTrackItem, getGraphFindingsByIds } from "./tracks";
import { artistCandidateIdsSql } from "./artist-membership";
import { releasedByTodaySql, upcomingAfterTodaySql } from "./release-day";

export {
  CATALOGUE_SORT_DEFAULT,
  CATALOGUE_SORTS,
  type CatalogueArtistGroup,
  type CatalogueGroupPage,
  CataloguePageOutOfRangeError,
  type CatalogueRecord,
  type CatalogueSort,
  flattenArtistGroups,
  flattenRecords,
  GRAPH_GROUP_PAGE_SIZE,
  GRAPH_GROUP_ROW_CEILING,
  GRAPH_GROUP_TRACK_LIMIT,
  pageNumbers,
  parseCatalogueSort,
} from "../catalogue";

type GroupTrackRow = {
  album: string | null;
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  album_slug: string | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number;
  group_key: string;
  isrc: string | null;
  key: string | null;
  preview_url: string | null;
  release_date: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

type GroupedTrackRow = GroupTrackRow & {
  group_name: string;

  group_release_date: string | null;

  group_slug: string | null;

  record_count: number;

  total_groups: number;

  total_tracks: number;

  track_count: number;
};

function groupRowIdentity(row: GroupTrackRow): RecordingIdentity {
  return {
    artists: parseArtistsJson(row.artists_json),
    isrc: row.isrc,
    releaseDate: row.release_date,
    spotifyUrl: row.spotify_url,
    title: row.title,
    trackId: row.track_id,
  };
}

function groupOrderSql(sort: CatalogueSort): string {
  const namelessLast = `(group_key = '') asc`;

  return sort === "recent"
    ? `${namelessLast}, (group_release_date is null) asc, group_release_date desc,
       group_name collate nocase asc`
    : `${namelessLast}, group_name collate nocase asc`;
}

function groupRankOrderSql(sort: CatalogueSort): string {
  return `${groupOrderSql(sort)}, group_key asc`;
}

function trackOrderSql(sort: CatalogueSort, prefix: string): string {
  const namelessRecordLast = `(${prefix}album is null) asc`;

  return sort === "recent"
    ? `${namelessRecordLast}, (${prefix}release_date is null) asc, ${prefix}release_date desc,
       ${prefix}album collate nocase asc, ${prefix}title collate nocase asc`
    : `${namelessRecordLast}, ${prefix}album collate nocase asc,
       (${prefix}release_date is null) asc, ${prefix}release_date asc,
       ${prefix}title collate nocase asc`;
}

function toTrack(row: TrackRowColumns): CatalogueTrackItem {
  return {
    albumImageUrl: bestAlbumCoverUrl({
      imageKey: row.album_image_key,
      imageState: row.album_image_state,
      imageUpdatedAt: row.album_image_updated_at,
      spotifyUrl: row.album_image_url,
    }),
    artists: parseArtistsJson(row.artists_json),
    bpm: row.bpm ?? undefined,
    durationMs: row.duration_ms || undefined,
    key: row.key ?? undefined,
    previewable: hasPreviewSource({ isrc: row.isrc, previewUrl: row.preview_url }),
    releaseDate: row.release_date ?? undefined,
    spotifyUrl: row.spotify_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

type TrackRowColumns = Omit<GroupTrackRow, "album" | "album_slug" | "group_key">;

type UpcomingRow = TrackRowColumns & { log_id: string | null };

const UPCOMING_ROW_COLUMNS = `tracks.track_id, tracks.title, tracks.artists_json, tracks.spotify_url,
          tracks.isrc, tracks.preview_url, tracks.album_image_url,
          al.image_key as album_image_key, al.image_state as album_image_state,
          al.image_updated_at as album_image_updated_at, tracks.duration_ms, tracks.bpm,
          tracks.key, tracks.release_date, findings.log_id`;

function upcomingPageSql(pageSql: string): string {
  return `select ${UPCOMING_ROW_COLUMNS}
          from (${pageSql}) upcoming_page
          join tracks on tracks.track_id = upcoming_page.track_id
          left join findings on findings.track_id = tracks.track_id
          left join albums al on al.id = tracks.album_id
          order by upcoming_page.release_date asc, upcoming_page.track_id asc`;
}

export async function listArtistUpcoming(
  artistId: string,
  today: string,
  page = 1,
): Promise<UpcomingTrackPage> {
  const db = await getDb();
  const predicate = `${upcomingAfterTodaySql("tracks.release_date")}
            and tracks.duplicate_of_track_id is null and tracks.dismissed_at is null`;
  const candidate = artistCandidateIdsSql("?", "(select name from artists where id = ?)", "?");
  const [result, count] = await Promise.all([
    db.execute({
      args: [
        artistId,
        artistId,
        today,
        artistId,
        today,
        GRAPH_GROUP_ROW_CEILING,
        (page - 1) * GRAPH_GROUP_ROW_CEILING,
      ],
      sql: upcomingPageSql(`select tracks.track_id as track_id, tracks.release_date as release_date
          from (${candidate}) artist_tracks
          join tracks on tracks.track_id = artist_tracks.track_id
          where ${predicate}
          order by tracks.release_date asc, tracks.track_id asc
          limit ? offset ?`),
    }),
    db.execute({
      args: [artistId, artistId, today, artistId, today],
      sql: `select count(*) as total from (${candidate}) artist_tracks
          join tracks on tracks.track_id = artist_tracks.track_id where ${predicate}`,
    }),
  ]);
  return upcomingPageFromRows(result.rows, count.rows, page);
}

export async function listLabelUpcoming(
  labelId: string,
  today: string,
  page = 1,
): Promise<UpcomingTrackPage> {
  const db = await getDb();
  const predicate = `tracks.label_id = ? and ${upcomingAfterTodaySql("tracks.release_date")}
            and tracks.duplicate_of_track_id is null and tracks.dismissed_at is null`;
  const [result, count] = await Promise.all([
    db.execute({
      args: [labelId, today, GRAPH_GROUP_ROW_CEILING, (page - 1) * GRAPH_GROUP_ROW_CEILING],
      sql: upcomingPageSql(`select tracks.track_id as track_id, tracks.release_date as release_date
          from tracks indexed by tracks_label_cover_idx
          where ${predicate}
          order by tracks.release_date asc, tracks.track_id asc
          limit ? offset ?`),
    }),
    db.execute({
      args: [labelId, today],
      sql: `select count(*) as total from tracks indexed by tracks_label_cover_idx where ${predicate}`,
    }),
  ]);
  return upcomingPageFromRows(result.rows, count.rows, page);
}

async function upcomingPageFromRows(
  rows: Awaited<ReturnType<Client["execute"]>>["rows"],
  countRows: Awaited<ReturnType<Client["execute"]>>["rows"],
  page: number,
): Promise<UpcomingTrackPage> {
  const total = Number(typedRows<{ total: number }>(countRows)[0]?.total ?? 0);
  const pageCount = Math.max(Math.ceil(total / GRAPH_GROUP_ROW_CEILING), 1);
  if (page > pageCount) {
    throw new CataloguePageOutOfRangeError();
  }
  const pageRows = typedRows<UpcomingRow>(rows);
  const findings = await getGraphFindingsByIds(
    pageRows.filter((row) => row.log_id !== null).map((row) => row.track_id),
  );
  return {
    findings,
    page,
    pageCount,
    total,
    tracks: pageRows.filter((row) => row.log_id === null).map(toTrack),
  };
}

const EMPTY = { groups: [], page: 1, pageCount: 1, totalGroups: 0 };

export async function listArtistCatalogue(
  artistId: string,
  sort: CatalogueSort,
  page: number,
  today?: string,
): Promise<CatalogueGroupPage<CatalogueRecord>> {
  const db = await getDb();
  const offset = (page - 1) * GRAPH_GROUP_PAGE_SIZE;

  const result = await db.execute({
    args: [
      artistId,
      ...(today === undefined ? [] : [today]),
      GRAPH_GROUP_TRACK_LIMIT,
      offset,
      offset + GRAPH_GROUP_PAGE_SIZE,
    ],
    sql: `with base as (
            select tracks.track_id as track_id, tracks.title as title,
                   tracks.artists_json as artists_json, tracks.spotify_url as spotify_url,
                   tracks.isrc as isrc, tracks.album as album, al.slug as album_slug,
                   tracks.album_image_url as album_image_url,
                   al.image_key as album_image_key, al.image_state as album_image_state,
                   al.image_updated_at as album_image_updated_at,
                   tracks.duration_ms as duration_ms, tracks.bpm as bpm,
                   tracks.key as key, tracks.preview_url as preview_url,
                   tracks.release_date as release_date,
                   lower(coalesce(tracks.album, '')) as group_key
            from tracks
            join track_artists ta on ta.track_id = tracks.track_id
            left join findings on findings.track_id = tracks.track_id
            left join albums al on al.id = tracks.album_id
            where ta.artist_id = ? and findings.track_id is null
                  and tracks.duplicate_of_track_id is null and tracks.dismissed_at is null
                  ${today === undefined ? "" : `and ${releasedByTodaySql("tracks.release_date")}`}
          ),
          ranked as (
            select base.*,
                   coalesce(min(base.album) over (partition by base.group_key), '') as group_name,
                   min(base.album_slug) over (partition by base.group_key) as group_slug,
                   max(base.release_date) over (partition by base.group_key)
                     as group_release_date,
                   count(*) over (partition by base.group_key) as track_count,
                   1 as record_count,
                   count(*) over () as total_tracks,
                   row_number() over (
                     partition by base.group_key
                     order by ${trackOrderSql(sort, "base.")}
                   ) as rn
            from base
          ),
          paged as (
            select ranked.*,
                   dense_rank() over (order by ${groupRankOrderSql(sort)}) as group_rn
            from ranked
          ),
          counted as (
            select paged.*, max(paged.group_rn) over () as total_groups from paged
          )
          select track_id, title, artists_json, spotify_url, isrc, album, album_slug,
                 album_image_url, album_image_key, album_image_state, album_image_updated_at,
                 duration_ms, bpm, key, preview_url,
                 release_date, group_key, group_name, group_slug, group_release_date,
                 track_count, record_count, total_tracks, total_groups
          from counted
          where rn <= ? and group_rn > ? and group_rn <= ?
          order by group_rn asc, rn asc`,
  });

  const rows = typedRows<GroupedTrackRow>(result.rows);

  if (rows.length === 0) {
    if (page > 1) {
      throw new CataloguePageOutOfRangeError();
    }

    return { ...EMPTY, totalTracks: 0 };
  }

  const totalGroups = Number(rows[0]?.total_groups ?? 0);
  let removed = 0;
  const groups = intoGroups(rows).map(({ head, rows: held }) => {
    const deduped = dedupeByRecordingIdentity(held, groupRowIdentity);

    removed += held.length - deduped.length;

    return {
      name: head.group_name === "" ? undefined : head.group_name,
      releaseDate: head.group_release_date ?? undefined,
      slug: head.group_slug ?? undefined,
      tracks: deduped.map(toTrack),
    };
  });

  return {
    groups,
    page,
    pageCount: Math.max(Math.ceil(totalGroups / GRAPH_GROUP_PAGE_SIZE), 1),
    totalGroups,

    totalTracks: Math.max(
      Number(rows[0]?.total_tracks ?? 0) - removed,
      flattenRecords(groups).length,
    ),
  };
}

export async function listLabelCatalogue(
  labelId: string,
  sort: CatalogueSort,
  page: number,
  today?: string,
): Promise<CatalogueGroupPage<CatalogueArtistGroup>> {
  const db = await getDb();
  const offset = (page - 1) * GRAPH_GROUP_PAGE_SIZE;

  const result = await db.execute({
    args: [
      labelId,
      ...(today === undefined ? [] : [today]),
      labelId,
      ...(today === undefined ? [] : [today]),
      labelId,
      ...(today === undefined ? [] : [today]),
      GRAPH_GROUP_TRACK_LIMIT,
      offset,
      offset + GRAPH_GROUP_PAGE_SIZE,
    ],

    sql: `with label_credits as (
            select distinct credit.value as name
            from tracks
            join json_each(tracks.artists_json) credit
            where tracks.label_id = ?
              ${today === undefined ? "" : `and ${releasedByTodaySql("tracks.release_date")}`}
          ),
          artist_slugs as (
            select lc.name as name, min(a.slug) as slug
            from label_credits lc
            join artists a on a.name = lc.name collate nocase
            where ${listedArtistWhere("a")}
            group by lc.name collate nocase
          ),
          base as (
            select tracks.track_id as track_id, tracks.title as title,
                   tracks.artists_json as artists_json, tracks.spotify_url as spotify_url,
                   tracks.isrc as isrc, tracks.album as album, al.slug as album_slug,
                   tracks.album_image_url as album_image_url,
                   al.image_key as album_image_key, al.image_state as album_image_state,
                   al.image_updated_at as album_image_updated_at,
                   tracks.duration_ms as duration_ms, tracks.bpm as bpm,
                   tracks.key as key, tracks.preview_url as preview_url,
                   tracks.release_date as release_date,
                   lower(credit.value) as group_key, credit.value as credit_name,
                   asl.slug as artist_slug
            from tracks
            left join findings on findings.track_id = tracks.track_id
            join json_each(tracks.artists_json) credit
            left join artist_slugs asl on asl.name = credit.value collate nocase
            left join albums al on al.id = tracks.album_id
            where tracks.label_id = ? and findings.track_id is null
                  and tracks.duplicate_of_track_id is null and tracks.dismissed_at is null
                  ${today === undefined ? "" : `and ${releasedByTodaySql("tracks.release_date")}`}
          ),
          ranked as (
            select base.*,
                   min(base.credit_name) over (partition by base.group_key) as group_name,
                   min(base.artist_slug) over (partition by base.group_key) as group_slug,
                   max(base.release_date) over (partition by base.group_key)
                     as group_release_date,
                   count(*) over (partition by base.group_key) as track_count,
                   dense_rank() over (
                     partition by base.group_key
                     order by lower(coalesce(base.album, ''))
                   ) as record_rank,
                   row_number() over (
                     partition by base.group_key
                     order by ${trackOrderSql(sort, "base.")}
                   ) as rn
            from base
          ),
          paged as (
            select ranked.*,
                   max(ranked.record_rank) over (partition by ranked.group_key) as record_count,
                   dense_rank() over (order by ${groupRankOrderSql(sort)}) as group_rn
            from ranked
          ),
          counted as (
            select paged.*, max(paged.group_rn) over () as total_groups from paged
          )
          select track_id, title, artists_json, spotify_url, isrc, album, album_slug,
                 album_image_url, album_image_key, album_image_state, album_image_updated_at,
                 duration_ms, bpm, key, preview_url,
                 release_date, group_key, group_name, group_slug, group_release_date,
                 track_count, record_count, total_groups,
                 (select count(*)
                  from tracks
                  left join findings on findings.track_id = tracks.track_id
                  where tracks.label_id = ? and findings.track_id is null
                        and tracks.duplicate_of_track_id is null
                        and tracks.dismissed_at is null
                        ${today === undefined ? "" : `and ${releasedByTodaySql("tracks.release_date")}`}) as total_tracks
          from counted
          where rn <= ? and group_rn > ? and group_rn <= ?
          order by group_rn asc, rn asc`,
  });

  const rows = typedRows<GroupedTrackRow>(result.rows);

  if (rows.length === 0) {
    if (page > 1) {
      throw new CataloguePageOutOfRangeError();
    }

    return { ...EMPTY, totalTracks: 0 };
  }

  const totalTracks = Number(rows[0]?.total_tracks ?? 0);
  const totalGroups = Number(rows[0]?.total_groups ?? 0);
  let removed = 0;
  const groups = intoGroups(rows).map(({ head, rows: held }) => {
    const records = intoRecords(held);

    removed += records.removed;

    return {
      name: head.group_name,
      recordCount: Number(head.record_count),
      records: records.records,
      slug: head.group_slug ?? undefined,
      truncated: Number(head.track_count) > held.length,
    };
  });

  return {
    groups,
    page,
    pageCount: Math.max(Math.ceil(totalGroups / GRAPH_GROUP_PAGE_SIZE), 1),
    totalGroups,

    totalTracks: Math.max(totalTracks - removed, flattenArtistGroups(groups).length),
  };
}

function intoGroups(
  rows: GroupedTrackRow[],
): Array<{ head: GroupedTrackRow; rows: GroupedTrackRow[] }> {
  const groups: Array<{ head: GroupedTrackRow; rows: GroupedTrackRow[] }> = [];

  for (const row of rows) {
    const current = groups.at(-1);

    if (current && current.head.group_key === row.group_key) {
      current.rows.push(row);
      continue;
    }

    groups.push({ head: row, rows: [row] });
  }

  return groups;
}

function intoRecords(rows: GroupTrackRow[]): { records: CatalogueRecord[]; removed: number } {
  const buckets: GroupTrackRow[][] = [];
  const index = new Map<string, GroupTrackRow[]>();

  for (const row of rows) {
    const key = (row.album ?? "").toLowerCase();
    const held = index.get(key);

    if (held) {
      held.push(row);
      continue;
    }

    const bucket = [row];

    index.set(key, bucket);
    buckets.push(bucket);
  }

  let removed = 0;
  const records = buckets.map((bucket) => {
    const deduped = dedupeByRecordingIdentity(bucket, groupRowIdentity);

    removed += bucket.length - deduped.length;

    const head = bucket[0];

    return {
      name: head?.album ?? undefined,
      releaseDate: head?.release_date ?? undefined,
      slug: head?.album_slug ?? undefined,
      tracks: deduped.map(toTrack),
    };
  });

  return { records, removed };
}
