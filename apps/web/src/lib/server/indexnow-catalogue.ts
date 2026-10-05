import { type InStatement } from "@libsql/client/web";
import { ARTIST_SOCIAL_PLATFORMS } from "../artist-socials";
import { logPageUrl, siteUrl } from "../fluncle-links";
import { ALBUM_INDEX_MIN_TRACKS } from "./albums";
import { ARTIST_INDEX_MIN_FINDINGS } from "./artists";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRows } from "./db";
import { entityPurgeUrl } from "./edge-cache";
import { buildIndexNowPayload } from "./indexnow";
import { LABEL_INDEX_MIN_TRACKS } from "./labels";
import { sitemapWindowStatement } from "./sitemap-data";
import { TRACK_PAGE_INDEXABLE_WHERE } from "./track-page";

export const INDEXNOW_WINDOW_SIZE = 1000;
export const INDEXNOW_CLAIM_LIMIT = 10000;
const KINDS = ["log", "artist", "label", "album", "track"] as const;
export type IndexNowKind = (typeof KINDS)[number];
export type IndexNowCursor = { after?: string; kind: IndexNowKind };
type ObservedPage = { lastmod: string | null; material: string; subject_id: string };
type Version = { changed_at: string; fingerprint: string; kind: IndexNowKind; subject_id: string };

const FINDING_LASTMOD =
  "max(coalesce(f.video_squared_at, ''), coalesce(f.updated_at, ''), f.added_at)";
const MIXTAPE_LASTMOD = "max(coalesce(m.set_video_at, ''), coalesce(m.updated_at, ''), m.added_at)";
const DUE_WHERE = "submitted_at is null or submitted_at < changed_at";
const PRIORITY =
  "case kind when 'log' then 0 when 'artist' then 1 when 'label' then 2 when 'album' then 3 else 4 end";
const LIVE_WHERE = `(
  (kind = 'log' and (
    exists (select 1 from findings f join tracks t on t.track_id = f.track_id where f.log_id = subject_id)
    or exists (select 1 from mixtapes m where m.log_id = subject_id and m.status = 'published' and m.added_at is not null)
  ))
  or (kind = 'artist' and exists (select 1 from artists where slug = subject_id and renderable_track_count >= ${ARTIST_INDEX_MIN_FINDINGS} and ${listedArtistWhere("artists")}))
  or (kind = 'label' and exists (select 1 from labels where slug = subject_id and renderable_track_count >= ${LABEL_INDEX_MIN_TRACKS}))
  or (kind = 'album' and exists (select 1 from albums where slug = subject_id and renderable_track_count >= ${ALBUM_INDEX_MIN_TRACKS}))
  or (kind = 'track' and exists (select 1 from tracks where track_id = subject_id and ${TRACK_PAGE_INDEXABLE_WHERE}))
)`;

function materialFields(alias: string, fields: string[]): string {
  return fields.map((field) => `'${field}', ${alias}.${field}`).join(", ");
}

function coverMaterial(alias: string, fallback: string, gated = true): string {
  const owned = `${gated ? `${alias}.image_state = 'resolved' and ` : ""}coalesce(${alias}.image_key, '') <> ''`;

  return `json_array(case when ${owned} then ${alias}.image_key end,
    case when ${owned} then ${alias}.image_updated_at end,
    case when not (${owned}) then ${fallback} end)`;
}

function entityMaterial(kind: "artist" | "album" | "label"): string {
  const common = materialFields("entity", [
    "name",
    "bio",
    "renderable_track_count",
    "certified_finding_count",
    "latest_release_date",
  ]);

  if (kind === "artist") {
    return `json_object(${common}, 'cover', ${coverMaterial("entity", "entity.image_url")},
      ${materialFields("entity", ["spotify_url", "mbid", "wikidata_qid", "discogs_url", "lastfm_url"])},
      'aliases', (select json_group_array(alias) from (select alias from artist_aliases where artist_id = entity.id and kind = 'name' and status in ('auto', 'confirmed') order by alias collate nocase)),
      'socials', (select json_group_array(json_array(platform, url)) from (select platform, url from artist_socials where artist_id = entity.id and status in ('auto', 'confirmed') and trim(url) <> '' and platform in (${ARTIST_SOCIAL_PLATFORMS.map((platform) => `'${platform}'`).join(",")}) order by platform, url)))`;
  }

  if (kind === "album") {
    return `json_object(${common}, 'cover', ${coverMaterial("entity", "null")},
      ${materialFields("entity", ["discogs_catno", "release_group_mbid", "upc"])})`;
  }

  return `json_object(${common}, 'cover', ${coverMaterial("entity", "null", false)},
    ${materialFields("entity", ["discogs_label_id", "mb_label_id", "founding_date", "founded_location"])},
    'aliases', (select json_group_array(alias) from (select alias from label_aliases where label_id = entity.id and status = 'confirmed' order by alias collate nocase)),
    'parent', (select json_array(name, slug) from labels parent where parent.id = entity.parent_label_id),
    'children', (select json_group_array(json_array(name, slug)) from (select name, slug from labels children where parent_label_id = entity.id order by name collate nocase asc limit 50)))`;
}

function findingMaterial(): string {
  return `json_object(${materialFields("t", ["title", "artists_json", "album", "label", "release_date", "spotify_url", "apple_music_url", "bpm", "key", "duration_ms", "isrc"])},
    ${materialFields("f", ["added_at", "note", "video_url", "video_squared_at", "video_vehicle", "video_grain", "video_register", "video_palette", "video_plate_subject", "video_structure", "video_model", "video_model_reasoning", "observation_audio_url", "observation_duration_ms", "observation_generated_at"])},
    'observation_alignment_length', length(f.observation_alignment_json),
    'video_upload_date', case when f.video_url is not null then coalesce(f.video_squared_at, f.updated_at, f.added_at) end,
    'cover', ${coverMaterial("al", "t.album_image_url")}, 'album_slug', al.slug,
    'label_slug', (select slug from labels where id = t.label_id),
    'galaxy', case when (select visible from map_visibility) then (select json_array(name, slug) from galaxies where id = f.galaxy_id) end,
    'newer', ${neighborMaterial(true)}, 'older', ${neighborMaterial(false)},
    'artists', (select json_group_array(json_array(name, slug)) from (
      select a.name, a.slug from track_artists ta join artists a on a.id = ta.artist_id
      where ta.track_id = t.track_id and ${listedArtistWhere("a")} order by ta.position, a.slug)),
    'socials', json_array(
      (select url from social_posts where track_id = t.track_id and platform = 'tiktok' and status = 'published' and url is not null order by published_at desc limit 1),
      (select url from social_posts where track_id = t.track_id and platform = 'youtube' and status = 'published' and url is not null order by published_at desc limit 1)))`;
}

function neighborMaterial(newer: boolean): string {
  const comparison = newer ? ">" : "<";
  const order = newer ? "asc" : "desc";
  return `(select json_array(n.log_id, nt.title, nt.artists_json) from findings n
    join tracks nt on nt.track_id = n.track_id where n.log_id is not null
    and (n.added_at ${comparison} f.added_at or (n.added_at = f.added_at and n.track_id ${comparison} t.track_id))
    order by n.added_at ${order}, n.track_id ${order} limit 1)`;
}

function mixtapeMaterial(): string {
  return `json_object(${materialFields("m", ["title", "note", "added_at", "recorded_at", "duration_ms", "sequence_number", "set_video_at"])},
    'members', (select json_group_array(json_array(log_id, title, artists_json, start_ms)) from (
      select f.log_id, t.title, t.artists_json, mt.start_ms from mixtape_tracks mt
      join tracks t on t.track_id = mt.track_id join findings f on f.track_id = t.track_id
      where mt.mixtape_id = m.id order by mt.position)),
    'member_count', (select count(*) from mixtape_tracks where mixtape_id = m.id),
    'socials', json_array(
      (select url from mixtape_social_posts where mixtape_id = m.id and platform = 'mixcloud' and status = 'published' and url is not null order by published_at desc limit 1),
      (select url from mixtape_social_posts where mixtape_id = m.id and platform = 'youtube' and status = 'published' and url is not null order by published_at desc limit 1),
      (select url from mixtape_social_posts where mixtape_id = m.id and platform = 'soundcloud' and status = 'published' and url is not null order by published_at desc limit 1)))`;
}

function pageWindowStatement(cursor: IndexNowCursor): InStatement {
  if (cursor.kind === "log") {
    return {
      args: [
        cursor.after ?? "",
        INDEXNOW_WINDOW_SIZE,
        cursor.after ?? "",
        INDEXNOW_WINDOW_SIZE,
        INDEXNOW_WINDOW_SIZE,
      ],
      sql: `with map_visibility as materialized (
        select count(*) > 0 and sum(case when name is null or slug is null then 1 else 0 end) = 0 as visible
        from galaxies where retired_at is null
      ) select * from (
        select * from (
          select f.log_id as subject_id, ${FINDING_LASTMOD} as lastmod,
            ${findingMaterial()} as material
          from findings f join tracks t on t.track_id = f.track_id
          left join albums al on al.id = t.album_id
          where f.log_id > ? order by f.log_id limit ?
        ) union all select * from (
          select m.log_id as subject_id, ${MIXTAPE_LASTMOD} as lastmod,
            ${mixtapeMaterial()} as material
          from mixtapes m where m.log_id > ? and m.status = 'published' and m.added_at is not null
          order by m.log_id limit ?
        )
      ) order by subject_id limit ?`,
    };
  }
  const plural = `${cursor.kind}s` as "artists" | "albums" | "labels" | "tracks";
  const window = sitemapWindowStatement(plural, INDEXNOW_WINDOW_SIZE, cursor.after);
  if (cursor.kind === "track") {
    const fields = materialFields("tracks", [
      "title",
      "artists_json",
      "album_id",
      "label_id",
      "release_date",
      "spotify_url",
      "apple_music_url",
      "beatport_url",
      "deezer_track_id",
      "in_release_id",
      "bpm",
      "key",
      "duration_ms",
      "isrc",
      "mb_recording_id",
    ]);
    return {
      args: window.args,
      sql: `with window as materialized (${window.sql})
        select tracks.track_id as subject_id, f.added_at as lastmod,
          json_object(${fields}, 'previewable', case when trim(coalesce(tracks.preview_url, '')) <> '' or trim(coalesce(tracks.isrc, '')) <> '' then 1 else 0 end,
            'youtube_video_id', case when tracks.youtube_video_official = 1 then tracks.youtube_video_id end,
            'album_name', album.name, 'album_slug', album.slug,
            'cover', ${coverMaterial("album", "tracks.album_image_url")},
            'label', tracks.label, 'label_slug', label.slug, 'log_id', f.log_id,
            'artist_links', (select json_group_array(json_array(name, slug)) from (select a.name, a.slug from track_artists ta join artists a on a.id = ta.artist_id where ta.track_id = tracks.track_id and ${listedArtistWhere("a")} order by ta.position, a.slug))) as material
        from window cross join tracks on tracks.track_id = window.track_id
        left join findings f on f.track_id = tracks.track_id
        left join albums album on album.id = tracks.album_id
        left join labels label on label.id = tracks.label_id
        order by tracks.track_id`,
    };
  }
  const relation =
    cursor.kind === "artist"
      ? "cross join track_artists ta on ta.track_id = t.track_id where ta.artist_id = entity.id"
      : `where t.${cursor.kind}_id = entity.id`;
  return {
    args: window.args,
    sql: `with window as materialized (${window.sql})
      select entity.slug as subject_id,
        (select max(f.added_at) from findings f cross join tracks t on t.track_id = f.track_id ${relation}) as lastmod,
        ${entityMaterial(cursor.kind)} as material
      from window cross join ${plural} entity on entity.slug = window.slug
      order by entity.slug`,
  };
}

async function fingerprint(material: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(JSON.parse(material))),
  );
  return Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function walkIndexNowCatalogue(cursor: IndexNowCursor = { kind: "log" }) {
  const db = await getDb();
  const observedAt = new Date().toISOString();
  const pages = typedRows<ObservedPage>((await db.execute(pageWindowStatement(cursor))).rows);
  const first = pages[0]?.subject_id;
  const last = pages.at(-1)?.subject_id;
  const versions =
    first !== undefined && last !== undefined
      ? typedRows<Version>(
          (
            await db.execute({
              args: [cursor.kind, first, last, ...pages.map((page) => page.subject_id)],
              sql: `select subject_id, fingerprint, changed_at from search_page_versions where kind = ? and subject_id >= ? and subject_id <= ? and subject_id in (${pages.map(() => "?").join(",")})`,
            })
          ).rows,
        )
      : [];
  const existing = new Map(versions.map((row) => [row.subject_id, row]));
  const statements: InStatement[] = [];
  let inserted = 0;
  let changed = 0;
  for (const page of pages) {
    const hash = await fingerprint(page.material);
    const previous = existing.get(page.subject_id);
    if (previous?.fingerprint === hash) {
      continue;
    }
    if (previous) {
      changed += 1;
    } else {
      inserted += 1;
    }
    statements.push({
      args: [
        cursor.kind,
        page.subject_id,
        hash,
        previous ? observedAt : page.lastmod || observedAt,
        observedAt,
      ],
      sql: `insert into search_page_versions (kind, subject_id, fingerprint, changed_at)
        values (?, ?, ?, ?)
        on conflict (kind, subject_id) do update set fingerprint = excluded.fingerprint, changed_at = ?, submitted_at = null
        where search_page_versions.fingerprint <> excluded.fingerprint`,
    });
  }
  const pruning: InStatement[] = [];
  if (last !== undefined) {
    pruning.push({
      args: [cursor.kind, cursor.after ?? "", last, ...pages.map((page) => page.subject_id)],
      sql: `delete from search_page_versions where kind = ? and subject_id > ? and subject_id <= ?
        and subject_id not in (${pages.map(() => "?").join(",")})`,
    });
  }
  if (pages.length < INDEXNOW_WINDOW_SIZE) {
    pruning.push({
      args: [cursor.kind, last ?? cursor.after ?? ""],
      sql: "delete from search_page_versions where kind = ? and subject_id > ?",
    });
  }
  const results = await db.batch([...statements, ...pruning], "write");
  const removed = results
    .slice(statements.length)
    .reduce((total, result) => total + result.rowsAffected, 0);
  const nextKind = KINDS[KINDS.indexOf(cursor.kind) + 1];
  const next: IndexNowCursor | null =
    pages.length === INDEXNOW_WINDOW_SIZE && last !== undefined
      ? { after: last, kind: cursor.kind }
      : nextKind
        ? { kind: nextKind }
        : null;
  return { changed, checked: pages.length, inserted, kind: cursor.kind, next, removed };
}

function pageUrl(version: Version): string {
  if (version.kind === "log") {
    return logPageUrl(version.subject_id);
  }
  if (version.kind === "track") {
    return `${siteUrl}/track/${encodeURIComponent(version.subject_id)}`;
  }
  return entityPurgeUrl(version.kind, version.subject_id);
}

async function dueCount(): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `select count(*) as n from search_page_versions indexed by search_page_versions_due_idx where (${DUE_WHERE})`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function claimIndexNowCatalogue(limit = INDEXNOW_CLAIM_LIMIT) {
  const db = await getDb();
  const rows = typedRows<Version>(
    (
      await db.execute({
        args: [limit],
        sql: `select kind, subject_id, fingerprint, changed_at from search_page_versions indexed by search_page_versions_due_idx
      where (${DUE_WHERE}) and ${LIVE_WHERE}
      order by ${PRIORITY}, changed_at desc, subject_id limit ?`,
      })
    ).rows,
  );
  const { host, key, keyLocation } = buildIndexNowPayload([]);
  return {
    due: await dueCount(),
    indexNow: { host, key, keyLocation },
    items: rows.map((row) => ({
      changedAt: row.changed_at,
      fingerprint: row.fingerprint,
      kind: row.kind,
      subjectId: row.subject_id,
      url: pageUrl(row),
    })),
  };
}

export async function ackIndexNowCatalogue(
  versions: {
    changedAt: string;
    fingerprint: string;
    kind: IndexNowKind;
    subjectId: string;
  }[],
) {
  const db = await getDb();
  const submittedAt = new Date().toISOString();
  const results = await db.batch(
    versions.map((version) => ({
      args: [submittedAt, version.kind, version.subjectId, version.fingerprint, version.changedAt],
      sql: "update search_page_versions set submitted_at = ? where kind = ? and subject_id = ? and fingerprint = ? and changed_at = ?",
    })),
    "write",
  );
  return {
    due: await dueCount(),
    stamped: results.reduce((sum, result) => sum + result.rowsAffected, 0),
  };
}
