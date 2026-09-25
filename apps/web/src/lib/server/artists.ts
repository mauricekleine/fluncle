import { parseArtistsJson } from "./artist-names";
import { type Client, type InStatement, type ResultSet } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { type ArtistListItem } from "@fluncle/contracts";
import { type ArtistSocialPlatform, ARTIST_SOCIAL_PLATFORMS } from "../artist-socials";
import { SIMILAR_ARTISTS_LIMIT, listSimilarArtistNeighbours } from "./artist-dossier";
import { validateSocialUrlForPlatform } from "./artist-resolution";
import { listedArtistWhere } from "./artist-visibility";
import { bioBypassColumns } from "./bio-review";
import { restaleCatalogueRankStatements } from "./catalogue-rank-restale";
import { getDb, typedRows } from "./db";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import {
  batchDueWorkMutationGroups,
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  dueWorkSourceMutationStatements,
  markDueWorkSourceMaintenanceFromSelectStatements,
  markDueWorkSourceMaintenanceStatements,
  MAX_DUE_WORK_CHUNK_SIZE,
} from "./due-work";
import {
  hubCountArtistEdgeStatements,
  type HubCountArtistDelta,
  hubCountArtistDeltaStatement,
} from "./hub-counts";
import {
  type CatalogueBrowsePage,
  type CatalogueBrowseQuery,
  type CatalogueHubNumberedPage,
  type CatalogueHubQuery,
  type HubOrder,
  type CatalogueListPage,
  countIndexableHubEntities,
  type EntitySitemapRow,
  hubCountsBySlug,
  hubCountsBySlugs,
  hubFindingCountsBySlug,
  hubInclusionWhere,
  listCatalogueBrowsePage,
  listHubPage,
  listHubThisMonth,
} from "./labels";
import { logEvent } from "./log";
import { bestArtistAvatarUrl } from "../media";
import { fetchArtistImages } from "./spotify";
import { deriveRemixerNames, fold } from "./track-match";
import {
  type ArtistOverviewItem,
  type ArtistSocial,
  type ArtistSocialsQueueItem,
  type ArtistSocialSource,
  type ArtistSocialStatus,
} from "../artist-review";

export const ARTIST_INDEX_MIN_FINDINGS = 3;

const PUBLIC_SOCIAL_PLATFORMS = new Set<string>(ARTIST_SOCIAL_PLATFORMS);

function compareSocialLinks(left: ArtistSocialLink, right: ArtistSocialLink): number {
  if (left.platform === right.platform) {
    return 0;
  }
  if (left.platform === "homepage") {
    return -1;
  }
  if (right.platform === "homepage") {
    return 1;
  }

  return left.platform.localeCompare(right.platform);
}

export type ArtistRecord = {
  bio?: string;

  discogsUrl: string | undefined;
  id: string;

  imageUrl: string | undefined;

  lastfmUrl: string | undefined;
  mbid: string | undefined;
  name: string;

  renderableTrackCount: number;
  slug: string;
  spotifyUrl: string | undefined;
  wikidataQid: string | undefined;
};

export type ArtistSocialLink = {
  platform: ArtistSocialPlatform;
  url: string;
};

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function getArtistBySlug(slug: string): Promise<ArtistRecord | undefined> {
  return resolveArtistBySlug(slug, "");
}

export async function getPublicArtistBySlug(slug: string): Promise<ArtistRecord | undefined> {
  return resolveArtistBySlug(slug, ` and ${listedArtistWhere()}`);
}

async function resolveArtistBySlug(
  slug: string,
  visibility: string,
): Promise<ArtistRecord | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select id, name, slug, spotify_url, mbid, wikidata_qid, discogs_url, lastfm_url, bio,
                 image_url, image_key, image_state, image_updated_at, renderable_track_count
          from artists where slug = ?${visibility} limit 1`,
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;

  if (!row || typeof row["id"] !== "string" || typeof row["name"] !== "string") {
    return undefined;
  }

  return {
    bio: optionalText(row["bio"]),
    discogsUrl: optionalText(row["discogs_url"]),
    id: row["id"],

    imageUrl: bestArtistAvatarUrl({
      imageKey: optionalText(row["image_key"]),
      imageState: optionalText(row["image_state"]),
      imageUpdatedAt: optionalText(row["image_updated_at"]),
      imageUrl: optionalText(row["image_url"]),
    }),
    lastfmUrl: optionalText(row["lastfm_url"]),
    mbid: optionalText(row["mbid"]),
    name: row["name"],
    renderableTrackCount: Number(row["renderable_track_count"] ?? 0),
    slug: typeof row["slug"] === "string" ? row["slug"] : slug,
    spotifyUrl: optionalText(row["spotify_url"]),
    wikidataQid: optionalText(row["wikidata_qid"]),
  };
}

export async function fillEmptyArtistBio(
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
        "artist",
        {
          args: [slug],
          sql: `select id as subject_id from artists
                where slug = ? and (bio is null or trim(bio) = '')`,
        },
        { producer: "artist-bio-fill" },
      ),
      {
        args: [bio, promptVersion ?? null, bypassedAt, violations, now, slug],
        sql: `update artists
                set bio = ?, bio_prompt_version = ?, bio_status = 'resolved',
                    bio_gate_bypassed_at = ?, bio_voice_violations = ?, updated_at = ?
              where slug = ?
                and (bio is null or trim(bio) = '')`,
      },
    ],
    "write",
  );
  const result = results.at(-1);

  return (result?.rowsAffected ?? 0) > 0;
}

export type EntityBioWorkItem = { id: string; name: string; slug: string };

export async function listArtistsMissingBio(limit: number): Promise<EntityBioWorkItem[]> {
  const db = await getDb();

  if (await isDueWorkCutoverEnabled()) {
    const page = await readPromotedDueWorkPage(db, "artist.bio", { limit });
    if (page.subjectIds.length === 0) {
      return [];
    }

    const result = await db.execute({
      args: page.subjectIds,
      sql: `select id, name, slug from artists
            where id in (${page.subjectIds.map(() => "?").join(", ")})
              and ${listedArtistWhere()}`,
    });
    const hydratedById = new Map(
      typedRows<EntityBioWorkItem>(result.rows).map((row) => [row.id, row] as const),
    );
    return page.subjectIds.flatMap((id) => {
      const row = hydratedById.get(id);
      return row ? [row] : [];
    });
  }

  const result = await db.execute({
    args: [limit],
    sql: `select a.id, a.name, a.slug
          from artists a
          where (a.bio is null or trim(a.bio) = '')
            and ${hubInclusionWhere("a", ARTIST_INDEX_MIN_FINDINGS)}
            and ${listedArtistWhere("a")}
          order by a.created_at asc
          limit ?`,
  });

  return typedRows<{ id: string; name: string; slug: string }>(result.rows).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

const PUBLIC_SOCIAL_STATUSES = new Set<string>(["auto", "confirmed"]);

export async function getPublicArtistSocials(artistId: string): Promise<ArtistSocialLink[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [artistId],
    sql: `select platform, url, status from artist_socials where artist_id = ?`,
  });

  const links: ArtistSocialLink[] = [];

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const platform = row["platform"];
    const url = optionalText(row["url"]);
    const status = row["status"];

    if (
      typeof platform === "string" &&
      typeof status === "string" &&
      PUBLIC_SOCIAL_STATUSES.has(status) &&
      url &&
      PUBLIC_SOCIAL_PLATFORMS.has(platform)
    ) {
      links.push({ platform: platform as ArtistSocialPlatform, url });
    }
  }

  return links.sort(compareSocialLinks);
}

export async function getPublicArtistAliasNames(artistId: string): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [artistId],
    sql: `select alias from artist_aliases
          where artist_id = ? and kind = 'name' and status in ('auto', 'confirmed')
          order by alias collate nocase asc`,
  });

  return typedRows<{ alias: string }>(result.rows).map((row) => row.alias);
}

export async function getArtistSlugMap(trackId: string): Promise<Record<string, string>> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select a.name, a.slug
          from artists a
          join track_artists ta on ta.artist_id = a.id
          where ta.track_id = ? and ${listedArtistWhere("a")}`,
  });

  const map: Record<string, string> = {};

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const name = row["name"];
    const slug = row["slug"];

    if (typeof name === "string" && typeof slug === "string") {
      map[fold(name)] = slug;
    }
  }

  return map;
}

export async function countArtistFindings(artistId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [artistId],
    sql: `select count(*) as finding_count
          from findings join tracks on tracks.track_id = findings.track_id
          join track_artists on track_artists.track_id = tracks.track_id
          where track_artists.artist_id = ? and findings.log_id is not null`,
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  const count = row?.["finding_count"];

  return typeof count === "number" ? count : 0;
}

export function artistSitemapWindowStatement(minTracks: number, limit: number, afterSlug?: string) {
  const seek = afterSlug === undefined ? "a.slug >= ?" : "a.slug > ?";

  return {
    args: [afterSlug ?? "", minTracks, limit],
    sql: `select a.slug as slug,
                 (select max(f.added_at)
                    from track_artists ta
                    join tracks t on t.track_id = ta.track_id
                    join findings f on f.track_id = t.track_id
                    where ta.artist_id = a.id) as lastmod,
                 (select t.album_image_url
                    from track_artists ta
                    join tracks t on t.track_id = ta.track_id
                    join findings f on f.track_id = t.track_id
                    where ta.artist_id = a.id
                      and f.log_id is not null
                      and f.added_at = (select max(f2.added_at)
                        from track_artists ta2
                        join tracks t2 on t2.track_id = ta2.track_id
                        join findings f2 on f2.track_id = t2.track_id
                        where ta2.artist_id = a.id and f2.log_id is not null)
                    limit 1) as cover_url
          from artists a
          where ${seek} and a.renderable_track_count >= ?
            and ${listedArtistWhere("a")}
          order by a.slug asc
          limit ?`,
  };
}

export async function listArtistSitemapRows(
  minTracks: number,
  window?: { afterSlug?: string; limit: number },
): Promise<EntitySitemapRow[]> {
  const db = await getDb();
  const result = await db.execute(
    window
      ? artistSitemapWindowStatement(minTracks, window.limit, window.afterSlug)
      : {
          args: [minTracks],
          sql: `select a.slug as slug,
                 max(findings.added_at) as lastmod,
                 (select t2.album_image_url
                    from (findings join tracks on tracks.track_id = findings.track_id) t2
                    join track_artists ta2 on ta2.track_id = t2.track_id
                    where ta2.artist_id = a.id and t2.log_id is not null
                    order by t2.added_at desc limit 1) as cover_url
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join tracks on tracks.track_id = ta.track_id
          left join findings on findings.track_id = tracks.track_id
          where a.renderable_track_count >= ? and ${listedArtistWhere("a")}
          group by a.id
          order by a.slug asc`,
        },
  );

  return typedRows<{
    cover_url: string | null;
    lastmod: string | null;
    slug: string;
  }>(result.rows).map((row) => ({
    coverImageUrl: row.cover_url ?? undefined,
    lastmod: row.lastmod ?? undefined,
    slug: row.slug,
  }));
}

export async function maxArtistSitemapLastmod(minTracks: number): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [minTracks],
    sql: `select max(findings.added_at) as lastmod
          from findings
          cross join tracks on tracks.track_id = findings.track_id
          cross join track_artists ta on ta.track_id = tracks.track_id
          cross join artists a on a.id = ta.artist_id
          where a.renderable_track_count >= ? and ${listedArtistWhere("a")}`,
  });

  return typedRows<{ lastmod: string | null }>(result.rows)[0]?.lastmod ?? undefined;
}

export type ArtistHubEntry = {
  certified: boolean;

  imageUrl: string | undefined;
  name: string;
  slug: string;

  trackCount: number;
};

export const ARTISTS_HUB_QUERY: CatalogueHubQuery<ArtistHubEntry> = {
  alias: "a",
  entity: "artists a",
  floor: ARTIST_INDEX_MIN_FINDINGS,
  hub: "artists",
  idExpr: "a.id",
  mapRow: (row) => ({
    certified: Boolean(row.certified),

    imageUrl: bestArtistAvatarUrl({
      imageKey: row.image_key ?? null,
      imageState: row.image_state ?? null,
      imageUpdatedAt: row.image_updated_at ?? null,
      imageUrl: row.image_url ?? null,
    }),
    name: row.name,
    slug: row.slug,
    trackCount: Number(row.track_count),
  }),
  nameExpr: "a.name",
  select: `a.name as name, a.image_url as image_url, a.image_key as image_key,
           a.image_state as image_state, a.image_updated_at as image_updated_at`,
  slugExpr: "a.slug",

  visibilityWhere: listedArtistWhere("a"),
};

export function countIndexableArtists(): Promise<number> {
  return countIndexableHubEntities(ARTISTS_HUB_QUERY);
}

export function listArtistsHubPage(
  page: number,
  nameFilter?: string,
  order: HubOrder = "az",
): Promise<CatalogueHubNumberedPage<ArtistHubEntry>> {
  return listHubPage(ARTISTS_HUB_QUERY, page, !nameFilter, nameFilter, order);
}

export function listArtistsThisMonth(now?: Date, limit?: number): Promise<ArtistHubEntry[]> {
  return listHubThisMonth(ARTISTS_HUB_QUERY, now, limit);
}

const ARTISTS_BROWSE_QUERY: CatalogueBrowseQuery = {
  alias: ARTISTS_HUB_QUERY.alias,
  entity: ARTISTS_HUB_QUERY.entity,
  floor: ARTISTS_HUB_QUERY.floor,
  hub: ARTISTS_HUB_QUERY.hub,
  idExpr: ARTISTS_HUB_QUERY.idExpr,
  nameExpr: "a.name",
  slugExpr: ARTISTS_HUB_QUERY.slugExpr,
  visibilityWhere: ARTISTS_HUB_QUERY.visibilityWhere,
};

export function listArtistsBrowsePage(page: number): Promise<CatalogueBrowsePage> {
  return listCatalogueBrowsePage(ARTISTS_BROWSE_QUERY, page);
}

export type ArtistChip = {
  imageUrl: string | undefined;
  name: string;
  slug: string;
};

async function listArtistsByEntity(
  column: "tracks.album_id" | "tracks.label_id",
  entityId: string,
): Promise<ArtistChip[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [entityId],
    sql: `select distinct a.name as name, a.slug as slug, a.image_url as image_url,
                 a.image_key as image_key, a.image_state as image_state,
                 a.image_updated_at as image_updated_at
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join tracks on tracks.track_id = ta.track_id
          join findings on findings.track_id = tracks.track_id
          where ${column} = ? and findings.log_id is not null
            and ${listedArtistWhere("a")}
          order by a.name collate nocase asc`,
  });

  return typedRows<{
    image_key: string | null;
    image_state: string | null;
    image_updated_at: string | null;
    image_url: string | null;
    name: string;
    slug: string;
  }>(result.rows).map((row) => ({
    imageUrl: bestArtistAvatarUrl({
      imageKey: row.image_key,
      imageState: row.image_state,
      imageUpdatedAt: row.image_updated_at,
      imageUrl: row.image_url,
    }),
    name: row.name,
    slug: row.slug,
  }));
}

export async function listArtistsByLabel(labelId: string): Promise<ArtistChip[]> {
  return listArtistsByEntity("tracks.label_id", labelId);
}

export async function listArtistsByAlbum(albumId: string): Promise<ArtistChip[]> {
  return listArtistsByEntity("tracks.album_id", albumId);
}

async function artistSpotifyUrlsBySlug(slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const placeholders = slugs.map(() => "?").join(", ");
  const result = await db.execute({
    args: slugs,
    sql: `select slug, spotify_url from artists where slug in (${placeholders})`,
  });

  const map = new Map<string, string>();

  for (const row of typedRows<{ slug: string; spotify_url: string | null }>(result.rows)) {
    if (row.spotify_url) {
      map.set(row.slug, row.spotify_url);
    }
  }

  return map;
}

export async function listArtistsApiPage(page: number): Promise<CatalogueListPage<ArtistListItem>> {
  const hub = await listHubPage(ARTISTS_HUB_QUERY, page, false);
  const slugs = hub.items.map((item) => item.slug);
  const [findingCounts, spotifyUrls] = await Promise.all([
    hubFindingCountsBySlug(ARTISTS_HUB_QUERY, slugs),
    artistSpotifyUrlsBySlug(slugs),
  ]);

  return {
    items: hub.items.map((item) => ({
      certified: item.certified,
      findingCount: findingCounts.get(item.slug) ?? 0,
      name: item.name,
      slug: item.slug,
      spotifyUrl: spotifyUrls.get(item.slug),
      trackCount: item.trackCount,
    })),
    page: hub.page,
    pageCount: hub.pageCount,
    total: hub.total,
  };
}

export async function getArtistListItemBySlug(slug: string): Promise<ArtistListItem | undefined> {
  const record = await getPublicArtistBySlug(slug);

  if (!record) {
    return undefined;
  }

  const counts = await hubCountsBySlug(ARTISTS_HUB_QUERY, slug);

  return {
    certified: counts.certified,
    findingCount: counts.findingCount,
    name: record.name,
    slug: record.slug,
    spotifyUrl: record.spotifyUrl,
    trackCount: counts.trackCount,
  };
}

export async function listSimilarArtistTiles(slugs: string[]): Promise<ArtistHubEntry[]> {
  const neighbours = await listSimilarArtistNeighbours(slugs, SIMILAR_ARTISTS_LIMIT);

  if (neighbours.length === 0) {
    return [];
  }

  const counts = await hubCountsBySlugs(
    ARTISTS_HUB_QUERY,
    neighbours.map((neighbour) => neighbour.slug),
  );

  return neighbours.map((neighbour) => {
    const entry = counts.get(neighbour.slug);

    return {
      certified: entry?.certified ?? false,
      imageUrl: neighbour.imageUrl,
      name: neighbour.name,
      slug: neighbour.slug,
      trackCount: entry?.trackCount ?? 0,
    };
  });
}

export async function listSimilarArtistsApi(slugs: string[]): Promise<ArtistListItem[]> {
  const neighbours = await listSimilarArtistNeighbours(slugs, SIMILAR_ARTISTS_LIMIT);

  if (neighbours.length === 0) {
    return [];
  }

  const resultSlugs = neighbours.map((neighbour) => neighbour.slug);
  const [counts, spotifyUrls] = await Promise.all([
    hubCountsBySlugs(ARTISTS_HUB_QUERY, resultSlugs),
    artistSpotifyUrlsBySlug(resultSlugs),
  ]);

  return neighbours.map((neighbour) => {
    const entry = counts.get(neighbour.slug);

    return {
      certified: entry?.certified ?? false,
      findingCount: entry?.findingCount ?? 0,
      name: neighbour.name,
      slug: neighbour.slug,
      spotifyUrl: spotifyUrls.get(neighbour.slug),
      trackCount: entry?.trackCount ?? 0,
    };
  });
}

export async function artistNamesBySlugs(slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) {
    return [];
  }

  const db = await getDb();
  const placeholders = slugs.map(() => "?").join(", ");
  const result = await db.execute({
    args: slugs,
    sql: `select slug, name from artists where slug in (${placeholders})
            and ${listedArtistWhere()}`,
  });

  const bySlug = new Map(
    typedRows<{ name: string; slug: string }>(result.rows).map((row) => [row.slug, row.name]),
  );

  return slugs.flatMap((slug) => {
    const name = bySlug.get(slug);

    return name ? [name] : [];
  });
}

export { parseArtistsJson } from "./artist-names";

export function toArtistSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function mintArtistSlug(id: string, name: string): Promise<string> {
  const db = await getDb();
  const base = toArtistSlug(name) || id.slice(0, 8);

  const first = await db.execute({
    args: [base],
    sql: `select 1 from artists where slug = ? limit 1`,
  });

  if (first.rows.length === 0) {
    return base;
  }

  for (let i = 2; i <= 64; i++) {
    const candidate = `${base}-${i}`;
    const clash = await db.execute({
      args: [candidate],
      sql: `select 1 from artists where slug = ? limit 1`,
    });

    if (clash.rows.length === 0) {
      return candidate;
    }
  }

  return `${base}-${id.slice(0, 8)}`;
}

export type CreditMbidsByTrack = ReadonlyMap<string, ReadonlyArray<null | string>>;

export function creditMbidTriples(
  trackIds: readonly string[],
  creditMbids: CreditMbidsByTrack,
): Array<[string, number, string]> {
  const triples: Array<[string, number, string]> = [];

  for (const trackId of trackIds) {
    const mbids = creditMbids.get(trackId);

    if (!mbids) {
      continue;
    }

    for (let i = 0; i < mbids.length; i++) {
      const mbid = mbids[i];

      if (mbid) {
        triples.push([trackId, i + 1, mbid]);
      }
    }
  }

  return triples;
}

type ArtistLinkStatement = {
  args: string[];
  sql: string;
};

export function buildArtistLinkStatement(
  trackIds: readonly string[],
  creditMbids?: CreditMbidsByTrack,
): ArtistLinkStatement {
  const placeholders = trackIds.map(() => "?").join(", ");
  const triples = creditMbids ? creditMbidTriples(trackIds, creditMbids) : [];
  const hasIdentity = triples.length > 0;
  const identityCte = hasIdentity
    ? `credit_id as materialized (
         select cast(json_extract(value, '$[0]') as text) as track_id,
                cast(json_extract(value, '$[1]') as integer) as position,
                cast(json_extract(value, '$[2]') as text) as mbid
           from json_each(?)
       ),
       `
    : "";
  const identityJoin = hasIdentity
    ? `left join credit_id
             on credit_id.track_id = tracks.track_id
            and credit_id.position = cast(credit.key as integer) + 1`
    : "";
  const mbidBranches = hasIdentity
    ? `select credit.track_id, artist.id as artist_id, credit.position, credit.is_catalogue
         from requested_credit credit
         cross join artists artist indexed by artists_mbid_idx on artist.mbid = credit.mbid
        where credit.mbid is not null
       union all
       select credit.track_id, artist.id as artist_id, credit.position, credit.is_catalogue
         from requested_credit credit
         cross join artists artist indexed by artists_name_nocase_idx
           on artist.name collate nocase = credit.artist_name
        where credit.mbid is not null
          and artist.mbid is null
          and not exists (
                select 1 from artists claimed indexed by artists_mbid_idx
                 where claimed.mbid = credit.mbid
              )
       union all
       `
    : "";
  const anonymousCreditWhere = hasIdentity ? "where credit.mbid is null" : "";

  return {
    args: [...(hasIdentity ? [JSON.stringify(triples)] : []), ...trackIds],
    sql: `with ${identityCte}requested_credit as materialized (
            select tracks.track_id,
                   cast(credit.key as integer) + 1 as position,
                   cast(credit.value as text) as artist_name,
                   tracks.is_catalogue,
                   ${hasIdentity ? "credit_id.mbid" : "null as mbid"}
              from tracks
              join json_each(tracks.artists_json) credit
              ${identityJoin}
             where tracks.track_id in (${placeholders})
          ),
          resolved_candidate as materialized (
            ${mbidBranches}select credit.track_id, artist.id as artist_id,
                                      credit.position, credit.is_catalogue
                                from requested_credit credit
                                cross join artists artist indexed by artists_name_nocase_idx
                                  on artist.name collate nocase = credit.artist_name
                                ${anonymousCreditWhere}
          ),
          resolved_edge as (
            select candidate.track_id, candidate.artist_id, candidate.position
              from resolved_candidate candidate
             where not exists (
                   select 1
                     from resolved_candidate earlier
                    where earlier.track_id = candidate.track_id
                      and earlier.artist_id = candidate.artist_id
                      and earlier.position < candidate.position
             )
          )
          insert or ignore into track_artists (track_id, artist_id, position)
          select track_id, artist_id, position from resolved_edge
          returning track_id, artist_id,
                    (select tracks.is_catalogue
                       from tracks
                      where tracks.track_id = track_artists.track_id) as is_catalogue,
                    (select tracks.key is not null and tracks.has_embedding = 1
                       from tracks
                      where tracks.track_id = track_artists.track_id) as is_rankable`,
  };
}

function artistLinkFollowUpStatements(inserted: ResultSet) {
  const newEdges = typedRows<{
    artist_id: string;
    is_catalogue: bigint | number;
    is_rankable: bigint | number;
    track_id: string;
  }>(inserted.rows).map((row) => ({
    artistId: row.artist_id,
    certified: Number(row.is_catalogue) === 0,
    rankable: Number(row.is_rankable) === 1,
    trackId: row.track_id,
  }));
  return [
    ...hubCountArtistEdgeStatements(newEdges),
    ...restaleCatalogueRankStatements(newEdges.map((edge) => edge.trackId)),
    ...(newEdges.length > 0
      ? [
          ...markDueWorkSourceMaintenanceStatements(
            [
              {
                subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                subjectType: "track" as const,
              },
              ...newEdges.map((edge) => ({
                subjectId: edge.trackId,
                subjectType: "track" as const,
              })),
              ...newEdges.map((edge) => ({
                subjectId: edge.artistId,
                subjectType: "artist" as const,
              })),
            ],
            { producer: "artist-edge-link" },
          ),
        ]
      : []),
  ];
}

export async function linkTracksToArtistEntities(
  trackIds: string[],
  creditMbids?: CreditMbidsByTrack,
  client?: Pick<Client, "batch" | "execute">,
): Promise<number> {
  if (trackIds.length === 0) {
    return 0;
  }

  const statement = buildArtistLinkStatement(trackIds, creditMbids);
  if (client) {
    const inserted = await client.execute(statement);
    const followUp = artistLinkFollowUpStatements(inserted);
    if (followUp.length > 0) {
      await client.batch(followUp);
    }
    return inserted.rows.length;
  }

  const db = await getDb();
  const transaction = await db.transaction("write");

  try {
    const inserted = await transaction.execute(statement);
    const followUp = artistLinkFollowUpStatements(inserted);
    if (followUp.length > 0) {
      await transaction.batch(followUp);
    }
    await transaction.commit();

    return inserted.rows.length;
  } finally {
    transaction.close();
  }
}

export async function stampRemixerRoles(
  trackIds: string[],
  client?: Pick<Client, "batch" | "execute">,
): Promise<number> {
  if (trackIds.length === 0) {
    return 0;
  }

  const db = client ?? (await getDb());
  const placeholders = trackIds.map(() => "?").join(", ");

  const rows = typedRows<{
    artist_id: string;
    artist_name: string;
    artists_json: string;
    title: string;
    track_id: string;
  }>(
    (
      await db.execute({
        args: trackIds,
        sql: `select ta.track_id, ta.artist_id, a.name as artist_name, t.title, t.artists_json
              from track_artists ta
              join artists a on a.id = ta.artist_id
              join tracks t on t.track_id = ta.track_id
              where ta.role is null and ta.track_id in (${placeholders})`,
      })
    ).rows,
  );

  if (rows.length === 0) {
    return 0;
  }

  const byTrack = new Map<
    string,
    { artistsJson: string; linked: Array<{ artistId: string; name: string }>; title: string }
  >();

  for (const row of rows) {
    let entry = byTrack.get(row.track_id);

    if (!entry) {
      entry = { artistsJson: row.artists_json, linked: [], title: row.title };
      byTrack.set(row.track_id, entry);
    }

    entry.linked.push({ artistId: row.artist_id, name: row.artist_name });
  }

  const mutationGroups: InStatement[][] = [];

  for (const [trackId, entry] of byTrack) {
    const remixerFolds = new Set(
      deriveRemixerNames(entry.title, parseArtistsJson(entry.artistsJson)).map(fold),
    );

    if (remixerFolds.size === 0) {
      continue;
    }

    for (const artist of entry.linked) {
      if (!remixerFolds.has(fold(artist.name))) {
        continue;
      }

      mutationGroups.push(
        dueWorkSourceMutationStatements(
          [
            {
              args: [artist.artistId, trackId],
              sql: `update track_artists set role = 'remixer'
                  where artist_id = ? and track_id = ? and role is null`,
            },
          ],
          [{ subjectId: trackId, subjectType: "track" }],
          {
            onlyIfLastSourceStatementChanged: true,
            producer: "artist-remixer-role-stamp",
          },
        ),
      );
    }
  }

  const results = await batchDueWorkMutationGroups(db, mutationGroups, MAX_DUE_WORK_CHUNK_SIZE);
  return results.reduce((count, group) => count + (group[0]?.rowsAffected ?? 0), 0);
}

async function resolveTrackArtist(
  db: Awaited<ReturnType<typeof getDb>>,
  name: string,
  spotifyArtistId: string | undefined,
  nowIso: string,
): Promise<string> {
  if (spotifyArtistId) {
    const existing = await db.execute({
      args: [spotifyArtistId],
      sql: `select id from artists where spotify_artist_id = ? limit 1`,
    });
    const id = (existing.rows[0] as Record<string, unknown> | undefined)?.["id"];
    if (typeof id === "string") {
      await db.execute({
        args: [name, nowIso, id],
        sql: `update artists set name = ?, updated_at = ? where id = ?`,
      });
      return id;
    }
  }

  const byName = await db.execute({
    args: [name],
    sql: `select id from artists where name = ? limit 1`,
  });
  const id = (byName.rows[0] as Record<string, unknown> | undefined)?.["id"];
  if (typeof id === "string") {
    if (spotifyArtistId) {
      await batchDueWorkSourceMutation(
        db,
        [
          {
            args: [spotifyArtistId, nowIso, id],
            sql: `update artists set spotify_artist_id = ?, updated_at = ? where id = ? and spotify_artist_id is null`,
          },
        ],
        [{ subjectId: id, subjectType: "artist" }],
        { onlyIfLastSourceStatementChanged: true, producer: "artist-spotify-adopt" },
      );
    }
    return id;
  }

  const newId = randomUUID();
  const slug = await mintArtistSlug(newId, name);
  const spotifyUrl = spotifyArtistId ? `https://open.spotify.com/artist/${spotifyArtistId}` : null;
  await db.batch(
    [
      {
        args: [newId, spotifyArtistId ?? null, name, slug, spotifyUrl, nowIso, nowIso],
        sql: `insert into artists (id, spotify_artist_id, name, slug, spotify_url, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?, ?)
              on conflict(spotify_artist_id) do update set
                name = excluded.name,
                updated_at = excluded.updated_at`,
      },
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        "artist",
        spotifyArtistId
          ? {
              args: [spotifyArtistId],
              sql: `select id as subject_id from artists where spotify_artist_id = ? limit 1`,
            }
          : {
              args: [newId],
              sql: `select id as subject_id from artists where id = ? limit 1`,
            },
        { producer: "artist-mint" },
      ),
    ],
    "write",
  );

  const fresh = await db.execute({
    args: spotifyArtistId ? [spotifyArtistId] : [name],
    sql: spotifyArtistId
      ? `select id from artists where spotify_artist_id = ? limit 1`
      : `select id from artists where name = ? limit 1`,
  });
  const freshId = (fresh.rows[0] as Record<string, unknown> | undefined)?.["id"];
  return typeof freshId === "string" ? freshId : newId;
}

export async function upsertTrackArtists(
  trackId: string,
  artistNames: string[],
  spotifyArtistIds: string[],
  options?: { fillImages?: boolean },
): Promise<void> {
  if (artistNames.length === 0) {
    return;
  }

  const db = await getDb();
  const nowIso = new Date().toISOString();
  const [heldEdges, trackRow] = await Promise.all([
    db.execute({
      args: [trackId],
      sql: `select artist_id from track_artists where track_id = ?`,
    }),
    db.execute({
      args: [trackId],
      sql: `select is_catalogue, key is not null and has_embedding = 1 as is_rankable
            from tracks where track_id = ? limit 1`,
    }),
  ]);
  const held = new Set(
    typedRows<{ artist_id: string }>(heldEdges.rows).map((row) => row.artist_id),
  );
  const catalogueFlag = typedRows<{
    is_catalogue: bigint | number;
    is_rankable: bigint | number;
  }>(trackRow.rows)[0];

  const edgeDelta: HubCountArtistDelta | undefined =
    catalogueFlag === undefined
      ? undefined
      : {
          certified: Number(catalogueFlag.is_catalogue) === 0 ? 1 : 0,
          rankable: Number(catalogueFlag.is_rankable) === 1 ? 1 : 0,
          renderable: 1,
        };

  let anyNewEdge = false;

  for (let i = 0; i < artistNames.length; i++) {
    const name = artistNames[i];
    const spotifyArtistId = spotifyArtistIds[i];
    const position = i + 1;

    if (!name) {
      continue;
    }

    const artistId = await resolveTrackArtist(db, name, spotifyArtistId, nowIso);

    const isNewEdge = !held.has(artistId);

    if (isNewEdge) {
      held.add(artistId);
      anyNewEdge = true;
    }

    await db.batch(
      [
        {
          args: [trackId, artistId, position],
          sql: `insert into track_artists (track_id, artist_id, position)
                values (?, ?, ?)
                on conflict(track_id, artist_id) do update set
                  position = excluded.position`,
        },
        ...(isNewEdge && edgeDelta ? [hubCountArtistDeltaStatement(artistId, edgeDelta)] : []),
        ...(isNewEdge
          ? [
              ...markDueWorkSourceMaintenanceStatements(
                [
                  { subjectId: trackId, subjectType: "track" },
                  {
                    subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                    subjectType: "track",
                  },
                  { subjectId: artistId, subjectType: "artist" },
                ],
                { producer: "artist-edge-upsert" },
              ),
            ]
          : []),
      ],
      "write",
    );
  }

  if (anyNewEdge && catalogueFlag !== undefined && Number(catalogueFlag.is_catalogue) === 1) {
    await batchDueWorkSourceMutation(
      db,
      restaleCatalogueRankStatements([trackId]),
      [
        { subjectId: trackId, subjectType: "track" },
        { subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID, subjectType: "track" },
      ],
      { producer: "artist-edge-rank-restale" },
    );
  }

  if (options?.fillImages ?? true) {
    try {
      await fillMissingArtistImages(spotifyArtistIds);
    } catch (error) {
      logEvent("warn", "artists.image-fill-failed", { error, trackId });
    }
  }
}

export async function mintArtistByMbid(name: string, mbid: string): Promise<string> {
  const db = await getDb();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const newId = randomUUID();
    const slug = await mintArtistSlug(newId, name);
    const nowIso = new Date().toISOString();

    try {
      await batchDueWorkSourceMutation(
        db,
        [
          {
            args: [newId, mbid, name, slug, nowIso, nowIso],
            sql: `insert into artists (id, mbid, name, slug, created_at, updated_at)
                  values (?, ?, ?, ?, ?, ?)`,
          },
        ],
        [{ subjectId: newId, subjectType: "artist" }],
        { producer: "artist-mbid-mint" },
      );

      return newId;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("artists.slug")) {
        throw error;
      }

      const existing = await db.execute({
        args: [mbid],
        sql: `select id from artists where mbid = ? limit 1`,
      });
      const existingId = typedRows<{ id: string }>(existing.rows)[0]?.id;

      if (existingId) {
        return existingId;
      }
    }
  }

  throw new Error(`mintArtistByMbid: slug contention for "${name}" persisted across retries`);
}

export async function adoptArtistMbid(artistId: string, mbid: string): Promise<void> {
  const db = await getDb();
  const nowIso = new Date().toISOString();

  await db.execute({
    args: [mbid, nowIso, artistId],
    sql: `update artists set mbid = coalesce(mbid, ?), updated_at = ?
          where id = ? and mbid is null`,
  });
}

export async function fillMissingArtistImages(spotifyArtistIds: string[]): Promise<number> {
  const ids = [...new Set(spotifyArtistIds.filter((id): id is string => Boolean(id)))];

  if (ids.length === 0) {
    return 0;
  }

  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  const missing = typedRows<{ id: string; spotify_artist_id: string }>(
    (
      await db.execute({
        args: ids,
        sql: `select id, spotify_artist_id from artists
              where spotify_artist_id in (${placeholders})
                and image_url is null
                and image_state = 'pending'`,
      })
    ).rows,
  );

  if (missing.length === 0) {
    return 0;
  }

  const result = await fetchArtistImages(missing.map((row) => row.spotify_artist_id));
  const nowIso = new Date().toISOString();
  let filled = 0;

  for (const row of missing) {
    const url = result.images.get(row.spotify_artist_id);

    if (!url) {
      continue;
    }

    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: [url, nowIso, row.id],
          sql: `update artists set image_url = ?, updated_at = ? where id = ? and image_url is null`,
        },
      ],
      [{ subjectId: row.id, subjectType: "artist" }],
      { onlyIfLastSourceStatementChanged: true, producer: "artist-image-fill" },
    );
    filled += 1;
  }

  return filled;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const KNOWN_PLATFORMS = new Set<string>(ARTIST_SOCIAL_PLATFORMS);

function isArtistSocialPlatform(value: string): value is ArtistSocialPlatform {
  return KNOWN_PLATFORMS.has(value);
}

function toArtistSocial(row: Record<string, unknown>): ArtistSocial {
  const platform = typeof row["platform"] === "string" ? row["platform"] : "homepage";
  const status = typeof row["status"] === "string" ? row["status"] : "candidate";
  const source = typeof row["source"] === "string" ? row["source"] : "operator";

  const reviewedAt = row["reviewed_at"];

  return {
    artistId: textOf(row["artist_id"]),
    createdAt: textOf(row["created_at"]),
    id: textOf(row["id"]),
    platform: isArtistSocialPlatform(platform) ? platform : "homepage",
    reviewedAt: typeof reviewedAt === "string" && reviewedAt ? reviewedAt : null,
    source: (source === "musicbrainz" || source === "firecrawl"
      ? source
      : "operator") as ArtistSocialSource,
    status: (status === "auto" || status === "confirmed"
      ? status
      : "candidate") as ArtistSocialStatus,
    url: textOf(row["url"]),
  };
}

export async function listArtistSocialsQueue(
  limit = 100,
  fresh = false,
): Promise<ArtistSocialsQueueItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.max(1, Math.min(limit, 500))],
    sql: `select a.id as artist_id, a.name, a.slug, a.spotify_url,
                 s.id, s.platform, s.url, s.source, s.status, s.created_at, s.reviewed_at
          from artists a
          join artist_socials s on s.artist_id = a.id
          where a.id in (
            select distinct artist_id from artist_socials
            where ${fresh ? "reviewed_at is null" : "status = 'candidate'"}
            limit ?
          )
          order by a.name asc, s.platform asc`,
  });

  const byArtist = new Map<string, ArtistSocialsQueueItem>();

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const artistId = textOf(row["artist_id"]);
    let artist = byArtist.get(artistId);

    if (!artist) {
      const spotifyUrl = row["spotify_url"];
      artist = {
        id: artistId,
        name: textOf(row["name"]),
        slug: textOf(row["slug"]),
        socials: [],
        spotifyUrl: typeof spotifyUrl === "string" ? spotifyUrl : null,
      };
      byArtist.set(artistId, artist);
    }

    artist.socials.push(toArtistSocial({ ...row, artist_id: artistId }));
  }

  return [...byArtist.values()];
}

export type ArtistsPage = {
  items: ArtistOverviewItem[];

  nextCursor: string | null;

  totalCount: number;
};

export type ArtistsPageQuery = { cursor?: string; limit?: number; search?: string };

const ARTISTS_PAGE_SIZE = 50;
const ARTISTS_PAGE_MAX = 100;

const ARTIST_CURSOR_SEP = "\u0000";
function encodeArtistCursor(name: string, id: string): string {
  return `${name}${ARTIST_CURSOR_SEP}${id}`;
}
function decodeArtistCursor(cursor: string | undefined): { id: string; name: string } | null {
  if (!cursor) {
    return null;
  }
  const at = cursor.lastIndexOf(ARTIST_CURSOR_SEP);
  if (at === -1) {
    return null;
  }
  return { id: cursor.slice(at + 1), name: cursor.slice(0, at) };
}

function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

type ArtistOverviewBase = { id: string; name: string; slug: string; spotifyUrl: string | null };

function toOverviewBase(row: {
  id: string;
  name: string;
  slug: string;
  spotify_url: string | null;
}): ArtistOverviewBase {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    spotifyUrl: typeof row.spotify_url === "string" ? row.spotify_url : null,
  };
}

async function hydrateArtistOverview(
  base: readonly ArtistOverviewBase[],
): Promise<ArtistOverviewItem[]> {
  if (base.length === 0) {
    return [];
  }

  const db = await getDb();
  const ids = base.map((artist) => artist.id);
  const placeholders = ids.map(() => "?").join(", ");

  const [socialsResult, countsResult] = await Promise.all([
    db.execute({
      args: ids,
      sql: `select artist_id, id, platform, url, source, status, created_at, reviewed_at
            from artist_socials
            where artist_id in (${placeholders})`,
    }),
    db.execute({
      args: ids,
      sql: `select ta.artist_id as artist_id, count(*) as finding_count
            from track_artists ta
            join findings f on f.track_id = ta.track_id
            where ta.artist_id in (${placeholders}) and f.log_id is not null
            group by ta.artist_id`,
    }),
  ]);

  const socialsByArtist = new Map<string, ArtistSocial[]>();
  for (const raw of socialsResult.rows) {
    const row = raw as Record<string, unknown>;
    const artistId = textOf(row["artist_id"]);
    const list = socialsByArtist.get(artistId) ?? [];
    list.push(toArtistSocial(row));
    socialsByArtist.set(artistId, list);
  }

  const countByArtist = new Map<string, number>();
  for (const raw of countsResult.rows) {
    const row = raw as Record<string, unknown>;
    countByArtist.set(textOf(row["artist_id"]), Number(row["finding_count"]) || 0);
  }

  return base.map((artist) => ({
    findingCount: countByArtist.get(artist.id) ?? 0,
    id: artist.id,
    name: artist.name,
    slug: artist.slug,
    socials: (socialsByArtist.get(artist.id) ?? []).sort((left, right) =>
      left.platform.localeCompare(right.platform),
    ),
    spotifyUrl: artist.spotifyUrl,
  }));
}

export async function listArtistsPage(query: ArtistsPageQuery = {}): Promise<ArtistsPage> {
  const db = await getDb();
  const limit = Math.max(1, Math.min(query.limit ?? ARTISTS_PAGE_SIZE, ARTISTS_PAGE_MAX));
  const after = decodeArtistCursor(query.cursor);
  const search = query.search?.trim();

  const where: string[] = [];
  const args: (number | string)[] = [];
  if (search) {
    where.push(`a.name like ? escape '\\'`);
    args.push(likeContains(search));
  }
  if (after) {
    where.push(`(a.name > ? or (a.name = ? and a.id > ?))`);
    args.push(after.name, after.name, after.id);
  }
  const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";

  const pageResult = await db.execute({
    args: [...args, limit + 1],
    sql: `select a.id, a.name, a.slug, a.spotify_url
          from artists a
          ${whereSql}
          order by a.name asc, a.id asc
          limit ?`,
  });

  const rows = typedRows<{ id: string; name: string; slug: string; spotify_url: string | null }>(
    pageResult.rows,
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const base = pageRows.map(toOverviewBase);

  const [items, countResult] = await Promise.all([
    hydrateArtistOverview(base),
    db.execute({
      args: search ? [likeContains(search)] : [],
      sql: `select count(*) as total from artists a ${
        search ? `where a.name like ? escape '\\'` : ""
      }`,
    }),
  ]);

  const last = pageRows.at(-1);
  const nextCursor = hasMore && last ? encodeArtistCursor(last.name, last.id) : null;
  const totalCount = Number((countResult.rows[0] as Record<string, unknown>)?.["total"]) || 0;

  return { items, nextCursor, totalCount };
}

export type FreshLinksData = {
  artists: ArtistOverviewItem[];

  total: number;
};

export const FRESH_LINKS_LIMIT = 100;

export async function listFreshLinks(): Promise<FreshLinksData> {
  const db = await getDb();

  const [freshResult, totalResult] = await Promise.all([
    db.execute({
      args: [FRESH_LINKS_LIMIT],
      sql: `select artist_id, min(created_at) as anchor_at
            from artist_socials
            where reviewed_at is null
            group by artist_id
            order by anchor_at asc
            limit ?`,
    }),
    db.execute(
      `select count(distinct artist_id) as total from artist_socials where reviewed_at is null`,
    ),
  ]);

  const freshIds = typedRows<{ anchor_at: string; artist_id: string }>(freshResult.rows).map(
    (row) => row.artist_id,
  );
  const total = Number((totalResult.rows[0] as Record<string, unknown>)?.["total"]) || 0;

  if (freshIds.length === 0) {
    return { artists: [], total };
  }

  const placeholders = freshIds.map(() => "?").join(", ");
  const baseResult = await db.execute({
    args: freshIds,
    sql: `select id, name, slug, spotify_url
          from artists
          where id in (${placeholders})
          order by name asc, id asc`,
  });
  const base = typedRows<{ id: string; name: string; slug: string; spotify_url: string | null }>(
    baseResult.rows,
  ).map(toOverviewBase);

  return { artists: await hydrateArtistOverview(base), total };
}

export type ArtistReviewRow = {
  artistId: string;
  name: string;

  anchorAt: string;

  pending: number;
};

export const ARTIST_REVIEW_QUEUE_LIMIT = 25;

export async function listArtistReviewRows(): Promise<ArtistReviewRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [ARTIST_REVIEW_QUEUE_LIMIT],
    sql: `select a.id as artist_id, a.name,
                 count(*) as pending, min(s.created_at) as anchor_at
          from artists a
          join artist_socials s on s.artist_id = a.id
          where s.reviewed_at is null
          group by a.id, a.name
          order by anchor_at asc
          limit ?`,
  });

  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;

    return {
      anchorAt: textOf(row["anchor_at"]),
      artistId: textOf(row["artist_id"]),
      name: textOf(row["name"]),
      pending: Number(row["pending"]) || 0,
    };
  });
}

async function getArtistSocialById(socialId: string): Promise<ArtistSocial | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [socialId],
    sql: `select id, artist_id, platform, url, source, status, created_at, reviewed_at
          from artist_socials where id = ? limit 1`,
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;

  return row ? toArtistSocial(row) : undefined;
}

export class ArtistSocialNotFoundError extends Error {
  constructor(socialId: string) {
    super(`No artist social with id ${socialId}`);
    this.name = "ArtistSocialNotFoundError";
  }
}

export async function confirmArtistSocial(socialId: string): Promise<ArtistSocial> {
  const existing = await getArtistSocialById(socialId);

  if (!existing) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  assertHttpUrl(existing.url);

  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [now, socialId],
    sql: `update artist_socials set status = 'confirmed', updated_at = ?
          where id = ? and status = 'candidate'`,
  });

  const social = await getArtistSocialById(socialId);

  if (!social) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  return social;
}

export class InvalidArtistSocialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArtistSocialError";
  }
}

export function assertHttpUrl(raw: string): string {
  const trimmed = raw.trim();

  if (!trimmed) {
    throw new InvalidArtistSocialError("A social URL is required");
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidArtistSocialError(`Not a valid URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidArtistSocialError(`Unsupported URL scheme: ${parsed.protocol}`);
  }

  return trimmed;
}

export async function addArtistSocial(
  artistId: string,
  platform: string,
  url: string,
): Promise<ArtistSocial> {
  if (!isArtistSocialPlatform(platform)) {
    throw new InvalidArtistSocialError(`Unknown platform: ${platform}`);
  }

  const trimmed = assertHttpUrl(url);
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [randomUUID(), artistId, platform, trimmed, now, now, now],
    sql: `insert into artist_socials
            (id, artist_id, platform, url, source, status, reviewed_at, created_at, updated_at)
          values (?, ?, ?, ?, 'operator', 'confirmed', ?, ?, ?)
          on conflict(artist_id, platform) do update set
            url = excluded.url,
            source = 'operator',
            status = 'confirmed',
            reviewed_at = excluded.reviewed_at,
            updated_at = excluded.updated_at`,
  });

  const result = await db.execute({
    args: [artistId, platform],
    sql: `select id, artist_id, platform, url, source, status, created_at, reviewed_at
          from artist_socials where artist_id = ? and platform = ? limit 1`,
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    throw new InvalidArtistSocialError("Failed to persist the social");
  }

  return toArtistSocial(row);
}

export async function reviewArtist(artistId: string): Promise<{ confirmed: number }> {
  const db = await getDb();
  const now = new Date().toISOString();

  const promoted = await db.execute({
    args: [now, artistId],
    sql: `update artist_socials set status = 'confirmed', updated_at = ?
          where artist_id = ? and status = 'candidate'`,
  });

  await db.execute({
    args: [now, now, artistId],
    sql: `update artist_socials set reviewed_at = ?, updated_at = ?
          where artist_id = ? and reviewed_at is null`,
  });

  return { confirmed: promoted.rowsAffected ?? 0 };
}

export async function reviewArtistSocial(socialId: string): Promise<ArtistSocial> {
  const existing = await getArtistSocialById(socialId);

  if (!existing) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  assertHttpUrl(existing.url);

  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [now, now, socialId],
    sql: `update artist_socials
          set reviewed_at = ?,
              status = case when status = 'candidate' then 'confirmed' else status end,
              updated_at = ?
          where id = ?`,
  });

  const social = await getArtistSocialById(socialId);

  if (!social) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  return social;
}

export async function updateArtistSocial(socialId: string, url: string): Promise<ArtistSocial> {
  const existing = await getArtistSocialById(socialId);

  if (!existing) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  const validation = await validateSocialUrlForPlatform(existing.platform, url);

  if (!validation.ok) {
    throw new InvalidArtistSocialError(validation.reason);
  }

  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [validation.url, now, now, socialId],
    sql: `update artist_socials
          set url = ?, source = 'operator', status = 'confirmed', reviewed_at = ?, updated_at = ?
          where id = ?`,
  });

  const social = await getArtistSocialById(socialId);

  if (!social) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  return social;
}

export async function removeArtistSocial(socialId: string): Promise<void> {
  const db = await getDb();

  await db.execute({ args: [socialId], sql: `delete from artist_socials where id = ?` });
}
