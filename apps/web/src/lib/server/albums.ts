import { type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { type AlbumDetail, type AlbumListItem } from "@fluncle/contracts";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { bestAlbumCoverUrl } from "../media";
import { bioBypassColumns } from "./bio-review";
import { getDb, typedRows } from "./db";
import {
  markDueWorkSourceMaintenanceFromSelectStatements,
  markDueWorkSourceMaintenanceStatements,
} from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { relinkTracksToEntity } from "./hub-counts";
import {
  type CatalogueBrowsePage,
  type CatalogueBrowseQuery,
  type CatalogueHubNumberedPage,
  type CatalogueHubQuery,
  type CatalogueListPage,
  countIndexableHubEntities,
  type EntitySitemapRow,
  hubCountsBySlug,
  hubFindingCountsBySlug,
  hubInclusionWhere,
  listCatalogueBrowsePage,
  listHubPage,
} from "./labels";

export const ALBUM_INDEX_MIN_TRACKS = 3;

type AlbumRow = {
  created_at: string;
  id: string;
  name: string;
  slug: string;
  updated_at: string;
};

export type AlbumRecord = {
  bio?: string;

  discogsCatno?: string;
  id: string;
  name: string;

  releaseDate?: string;

  releaseGroupMbid?: string;
  slug: string;

  upc?: string;
};

const ALBUM_COLUMNS = "id, name, slug, created_at, updated_at";

export function albumSlug(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const slug = slugify(raw.trim());

  return slug === "" ? undefined : slug;
}

function toAlbumRecord(row: AlbumRow): AlbumRecord {
  return { id: row.id, name: row.name, slug: row.slug };
}

export async function ensureAlbum(
  raw: string | null | undefined,
  releaseGroupMbid?: null | string,
  client?: Pick<Client, "batch" | "execute">,
): Promise<string | undefined> {
  const db = client ?? (await getDb());
  const mbid =
    typeof releaseGroupMbid === "string" && releaseGroupMbid.trim()
      ? releaseGroupMbid.trim()
      : null;

  if (mbid) {
    const byMbid = await db.execute({
      args: [mbid],
      sql: `select id from albums where release_group_mbid = ? limit 1`,
    });
    const existingId = typedRows<{ id: string }>(byMbid.rows)[0]?.id;

    if (existingId) {
      return existingId;
    }
  }

  const slug = albumSlug(raw);

  if (!slug || typeof raw !== "string") {
    return undefined;
  }

  const now = new Date().toISOString();
  const albumId = `alb_${randomUUID()}`;

  await db.batch(
    [
      {
        args: [albumId, raw.trim(), slug, mbid, now, now],
        sql: `insert into albums (id, name, slug, release_group_mbid, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?)
              on conflict (slug) do nothing`,
      },
      ...markDueWorkSourceMaintenanceStatements([{ subjectId: albumId, subjectType: "album" }], {
        onlyIfPreviousStatementChanged: true,
        producer: "album-mint",
      }),
    ],
    "write",
  );

  const result = await db.execute({
    args: [slug],
    sql: `select id, release_group_mbid from albums where slug = ? limit 1`,
  });
  const row = typedRows<{ id: string; release_group_mbid: null | string }>(result.rows)[0];

  if (!row) {
    return undefined;
  }

  if (mbid && !row.release_group_mbid) {
    await db
      .execute({
        args: [mbid, new Date().toISOString(), row.id],
        sql: `update albums set release_group_mbid = ?, updated_at = ?
              where id = ? and release_group_mbid is null`,
      })
      .catch(() => undefined);
  }

  return row.id;
}

export async function linkTrackToAlbum(
  trackId: string,
  raw: string | null | undefined,
): Promise<void> {
  const albumId = await ensureAlbum(raw);

  if (!albumId) {
    return;
  }

  await relinkTracksToEntity("albums", albumId, [trackId]);
}

export async function getAlbumBySlug(slug: string): Promise<AlbumRecord | undefined> {
  const db = await getDb();

  const result = await db.execute({
    args: [slug],
    sql: `select ${ALBUM_COLUMNS}, bio, release_group_mbid, upc, discogs_catno,
                 (select min(t.release_date) from tracks t
                    where t.album_id = albums.id and t.release_date is not null) as release_date
          from albums where slug = ? limit 1`,
  });

  const row = typedRows<
    AlbumRow & {
      bio: string | null;
      discogs_catno: string | null;
      release_date: string | null;
      release_group_mbid: string | null;
      upc: string | null;
    }
  >(result.rows)[0];

  return row
    ? {
        ...toAlbumRecord(row),
        bio: typeof row.bio === "string" && row.bio.trim() ? row.bio : undefined,
        discogsCatno:
          typeof row.discogs_catno === "string" && row.discogs_catno.trim()
            ? row.discogs_catno
            : undefined,
        releaseDate:
          typeof row.release_date === "string" && row.release_date ? row.release_date : undefined,
        releaseGroupMbid:
          typeof row.release_group_mbid === "string" && row.release_group_mbid
            ? row.release_group_mbid
            : undefined,
        upc: typeof row.upc === "string" && row.upc ? row.upc : undefined,
      }
    : undefined;
}

export type AlbumDiscogsFacts = {
  catno?: string;

  styles?: string[];
};

export async function storeAlbumDiscogsFacts(
  albumId: string,
  facts: AlbumDiscogsFacts,
): Promise<boolean> {
  const db = await getDb();
  const catno = facts.catno?.trim();
  const styles = (facts.styles ?? []).map((style) => style.trim()).filter((style) => style !== "");
  const now = new Date().toISOString();

  const result = await db.execute({
    args: [
      catno && catno.length > 0 ? catno : null,
      styles.length > 0 ? JSON.stringify(styles) : null,
      catno && catno.length > 0 ? "resolved" : "none",
      now,
      now,
      albumId,
    ],
    sql: `update albums
            set discogs_catno = ?,
                discogs_styles = ?,
                discogs_state = ?,
                discogs_failures = 0,
                discogs_attempted_at = ?,
                updated_at = ?
          where id = ? and discogs_state = 'pending'`,
  });

  return result.rowsAffected > 0;
}

export async function recordAlbumDiscogsFailure(albumId: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), albumId],
    sql: `update albums
            set discogs_failures = discogs_failures + 1,
                discogs_attempted_at = ?
          where id = ? and discogs_state = 'pending'`,
  });
}

export async function storeAlbumDiscogsFactsForTrack(
  trackId: string,
  facts: AlbumDiscogsFacts,
): Promise<boolean> {
  const db = await getDb();
  const target = await db.execute({
    args: [trackId],
    sql: `select album_id from tracks where track_id = ? and album_id is not null limit 1`,
  });

  const albumId = typedRows<{ album_id: string }>(target.rows)[0]?.album_id;

  return typeof albumId === "string" ? storeAlbumDiscogsFacts(albumId, facts) : false;
}

export async function fillEmptyAlbumBio(
  slug: string,
  bio: string,
  promptVersion?: number | null,
  gateBypass?: readonly string[] | null,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date().toISOString();
  const [bypassedAt, violations] = bioBypassColumns(gateBypass, now);
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "album",
        {
          args: [slug],
          sql: `select id as subject_id from albums
                where slug = ? and (bio is null or trim(bio) = '')`,
        },
        { producer: "album-bio-fill" },
      ),
      {
        args: [bio, promptVersion ?? null, bypassedAt, violations, now, slug],
        sql: `update albums
                set bio = ?, bio_prompt_version = ?, bio_status = 'resolved',
                    bio_gate_bypassed_at = ?, bio_voice_violations = ?, updated_at = ?
              where slug = ?
                and (bio is null or trim(bio) = '')`,
      },
    ],
    "write",
  );

  return (results.at(-1)?.rowsAffected ?? 0) > 0;
}

export type AlbumBioWorkItem = { id: string; name: string; slug: string };

export async function listAlbumsMissingBio(limit: number): Promise<AlbumBioWorkItem[]> {
  const db = await getDb();

  if (await isDueWorkCutoverEnabled()) {
    const page = await readPromotedDueWorkPage(db, "album.bio", { limit });
    if (page.subjectIds.length === 0) {
      return [];
    }

    const result = await db.execute({
      args: page.subjectIds,
      sql: `select id, name, slug from albums
            where id in (${page.subjectIds.map(() => "?").join(", ")})`,
    });
    const hydratedById = new Map(
      typedRows<AlbumBioWorkItem>(result.rows).map((row) => [row.id, row] as const),
    );
    return page.subjectIds.flatMap((id) => {
      const row = hydratedById.get(id);
      return row ? [row] : [];
    });
  }

  const result = await db.execute({
    args: [limit],
    sql: `select a.id, a.name, a.slug
          from albums a
          where (a.bio is null or trim(a.bio) = '')
            and ${hubInclusionWhere("a", ALBUM_INDEX_MIN_TRACKS)}
          order by a.created_at asc
          limit ?`,
  });

  return typedRows<{ id: string; name: string; slug: string }>(result.rows).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

const ALBUM_COVER_SELECT = `albums.image_key as image_key, albums.image_state as image_state,
           albums.image_updated_at as image_updated_at`;

type AlbumCoverRow = {
  cover_url?: null | string;
  image_key?: null | string;
  image_state?: null | string;
  image_updated_at?: null | string;
};

function albumCover(row: AlbumCoverRow): string | undefined {
  return bestAlbumCoverUrl({
    imageKey: row.image_key,
    imageState: row.image_state,
    imageUpdatedAt: row.image_updated_at,
    spotifyUrl: row.cover_url,
  });
}

export function albumSitemapWindowStatement(minTracks: number, limit: number, afterSlug?: string) {
  const seek = afterSlug === undefined ? "albums.slug >= ?" : "albums.slug > ?";

  return {
    args: [afterSlug ?? "", minTracks, limit],
    sql: `select albums.slug as slug, ${ALBUM_COVER_SELECT},
                 (select max(f.added_at)
                    from tracks t join findings f on f.track_id = t.track_id
                    where t.album_id = albums.id) as lastmod,
                 (select t.album_image_url
                    from tracks t join findings f on f.track_id = t.track_id
                    where t.album_id = albums.id
                      and f.log_id is not null
                      and f.added_at = (select max(f2.added_at)
                        from tracks t2 join findings f2 on f2.track_id = t2.track_id
                        where t2.album_id = albums.id and f2.log_id is not null)
                    limit 1) as cover_url
          from albums
          where ${seek} and albums.renderable_track_count >= ?
          order by albums.slug asc
          limit ?`,
  };
}

export async function listAlbumSitemapRows(
  minTracks: number,
  window?: { afterSlug?: string; limit: number },
): Promise<EntitySitemapRow[]> {
  const db = await getDb();
  const result = await db.execute(
    window
      ? albumSitemapWindowStatement(minTracks, window.limit, window.afterSlug)
      : {
          args: [minTracks],
          sql: `select albums.slug as slug, ${ALBUM_COVER_SELECT},
                 max(findings.added_at) as lastmod,
                 (select t2.album_image_url
                    from findings f2 join tracks t2 on t2.track_id = f2.track_id
                    where t2.album_id = albums.id and f2.log_id is not null
                    order by f2.added_at desc limit 1) as cover_url
          from albums
          join tracks on tracks.album_id = albums.id
          left join findings on findings.track_id = tracks.track_id
          where albums.renderable_track_count >= ?
          group by albums.id
          order by albums.slug asc`,
        },
  );

  return typedRows<AlbumCoverRow & { lastmod: string | null; slug: string }>(result.rows).map(
    (row) => ({
      coverImageUrl: albumCover(row),
      lastmod: row.lastmod ?? undefined,
      slug: row.slug,
    }),
  );
}

export async function maxAlbumSitemapLastmod(minTracks: number): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [minTracks],
    sql: `select max(findings.added_at) as lastmod
          from findings
          cross join tracks on tracks.track_id = findings.track_id
          cross join albums on albums.id = tracks.album_id
          where albums.renderable_track_count >= ?`,
  });

  return typedRows<{ lastmod: string | null }>(result.rows)[0]?.lastmod ?? undefined;
}

export type AlbumHubEntry = {
  certified: boolean;

  coverImageUrl: string | undefined;
  name: string;
  slug: string;

  trackCount: number;
};

export const ALBUMS_HUB_QUERY: CatalogueHubQuery<AlbumHubEntry> = {
  alias: "albums",
  entity: "albums",
  floor: ALBUM_INDEX_MIN_TRACKS,
  hub: "albums",
  idExpr: "albums.id",
  mapRow: (row) => ({
    certified: Boolean(row.certified),
    coverImageUrl: albumCover(row),
    name: row.name,
    slug: row.slug,
    trackCount: Number(row.track_count),
  }),
  nameExpr: "albums.name",
  select: `albums.name as name, ${ALBUM_COVER_SELECT},
           (select t2.album_image_url from tracks t2
              where t2.album_id = albums.id and t2.album_image_url is not null
              order by t2.release_date is null asc, t2.release_date desc, t2.track_id asc
              limit 1) as cover_url`,
  slugExpr: "albums.slug",
};

export function countIndexableAlbums(): Promise<number> {
  return countIndexableHubEntities(ALBUMS_HUB_QUERY);
}

export function listAlbumsHubPage(
  page: number,
  nameFilter?: string,
): Promise<CatalogueHubNumberedPage<AlbumHubEntry>> {
  return listHubPage(ALBUMS_HUB_QUERY, page, false, nameFilter);
}

const ALBUMS_BROWSE_QUERY: CatalogueBrowseQuery = {
  alias: ALBUMS_HUB_QUERY.alias,
  entity: ALBUMS_HUB_QUERY.entity,
  floor: ALBUMS_HUB_QUERY.floor,
  hub: ALBUMS_HUB_QUERY.hub,
  idExpr: ALBUMS_HUB_QUERY.idExpr,
  nameExpr: "albums.name",
  slugExpr: ALBUMS_HUB_QUERY.slugExpr,
};

export function listAlbumsBrowsePage(page: number): Promise<CatalogueBrowsePage> {
  return listCatalogueBrowsePage(ALBUMS_BROWSE_QUERY, page);
}

const ALBUM_COVER_JSON = `${ALBUM_COVER_SELECT},
           (select t2.album_image_url from tracks t2
              where t2.album_id = albums.id and t2.album_image_url is not null
              order by t2.release_date is null asc, t2.release_date desc, t2.track_id asc
              limit 1) as cover_url`;

export async function listAlbumsApiPage(page: number): Promise<CatalogueListPage<AlbumListItem>> {
  const hub = await listHubPage(ALBUMS_HUB_QUERY, page);
  const findingCounts = await hubFindingCountsBySlug(
    ALBUMS_HUB_QUERY,
    hub.items.map((item) => item.slug),
  );

  return {
    items: hub.items.map((item) => ({
      certified: item.certified,
      coverImageUrl: item.coverImageUrl,
      findingCount: findingCounts.get(item.slug) ?? 0,
      name: item.name,
      slug: item.slug,
      trackCount: item.trackCount,
    })),
    page: hub.page,
    pageCount: hub.pageCount,
    total: hub.total,
  };
}

async function albumCoverUrl(albumId: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [albumId],
    sql: `select ${ALBUM_COVER_JSON} from albums where albums.id = ? limit 1`,
  });
  const row = typedRows<AlbumCoverRow>(result.rows)[0];

  return row ? albumCover(row) : undefined;
}

export async function getAlbumDetail(slug: string): Promise<AlbumDetail | undefined> {
  const record = await getAlbumBySlug(slug);

  if (!record) {
    return undefined;
  }

  const counts = await hubCountsBySlug(ALBUMS_HUB_QUERY, slug);
  const coverImageUrl = await albumCoverUrl(record.id);

  return {
    bio: record.bio,
    certified: counts.certified,
    coverImageUrl,
    findingCount: counts.findingCount,
    name: record.name,
    releaseDate: record.releaseDate,
    releaseGroupMbid: record.releaseGroupMbid,
    slug: record.slug,
    trackCount: counts.trackCount,
    upc: record.upc,
  };
}
