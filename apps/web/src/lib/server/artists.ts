import { randomUUID } from "node:crypto";
import { type ArtistListItem } from "@fluncle/contracts";
import { type ArtistSocialPlatform, ARTIST_SOCIAL_PLATFORMS } from "../artist-socials";
import { SIMILAR_ARTISTS_LIMIT, listSimilarArtistNeighbours } from "./artist-dossier";
import { validateSocialUrlForPlatform } from "./artist-resolution";
import { getDb, typedRows } from "./db";
import {
  type CatalogueBrowsePage,
  type CatalogueBrowseQuery,
  type CatalogueHubNumberedPage,
  type CatalogueHubQuery,
  type CatalogueListPage,
  type EntitySitemapRow,
  hubCountsBySlug,
  hubCountsBySlugs,
  hubFindingCountsBySlug,
  listCatalogueBrowsePage,
  listHubPage,
} from "./labels";
import { logEvent } from "./log";
import { bestArtistAvatarUrl } from "../media";
import { fetchArtistImages } from "./spotify";
import { deriveRemixerNames, fold } from "./track-match";

// The thin-content gate for artist pages: a `/artist/<slug>` page indexes (and
// enters the sitemap) only at this many coordinate-bearing findings or more.
// Below it the page still serves 200 (deep links + link equity) but is
// `noindex,follow` and stays out of the sitemap. Shared by the route + the
// sitemap so the gate is defined once (Unit 3, artist-relationship RFC §3).
export const ARTIST_INDEX_MIN_FINDINGS = 3;

// The platforms allowed onto the public artist page + `sameAs` (any known platform;
// a row outside this set, or with a `candidate` status, never reaches the page).
const PUBLIC_SOCIAL_PLATFORMS = new Set<string>(ARTIST_SOCIAL_PLATFORMS);

// The public display order: the artist's own homepage/website FIRST (when one
// exists), then every other platform alphabetically by key. Homepage leads because
// it is the artist's canonical front door; the rest read as a plain, predictable
// A–Z rank rather than a hand-curated hierarchy.
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

/** The canonical artist identity record the pages + JSON-LD read. */
export type ArtistRecord = {
  /**
   * The artist's voiced public bio (the entity sibling of a finding's `note`), or undefined
   * when none is authored yet. Optional so the many callers that mint a bare `ArtistRecord`
   * need not carry it; the surfacing PR reads it off `getArtistBySlug`. See lib/server/bio.ts.
   */
  bio?: string;
  id: string;
  /**
   * The artist's OWN portrait — the owned avatar master (RFC U3b) when resolved, else the raw
   * Spotify `image_url`, else undefined (a monogram tile / the album-cover fallback covers it).
   * The entity's `image` in the MusicGroup JSON-LD and the page's og:image, preferred over an
   * album cover; also the masthead ArtistAvatar's source.
   */
  imageUrl: string | undefined;
  mbid: string | undefined;
  name: string;
  slug: string;
  spotifyUrl: string | undefined;
  wikidataQid: string | undefined;
};

/** A public (auto/confirmed) social link on the artist page + `sameAs`. */
export type ArtistSocialLink = {
  platform: ArtistSocialPlatform;
  url: string;
};

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Resolve one artist by its public slug (null = no such artist). */
export async function getArtistBySlug(slug: string): Promise<ArtistRecord | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select id, name, slug, spotify_url, mbid, wikidata_qid, bio,
                 image_url, image_key, image_state, image_updated_at
          from artists where slug = ? limit 1`,
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;

  if (!row || typeof row["id"] !== "string" || typeof row["name"] !== "string") {
    return undefined;
  }

  return {
    bio: optionalText(row["bio"]),
    id: row["id"],
    // The OWNED avatar master (RFC U3b) when resolved, else the raw Spotify image_url — the same
    // `bestArtistAvatarUrl` ladder the /artists index + the graph chips use.
    imageUrl: bestArtistAvatarUrl({
      imageKey: optionalText(row["image_key"]),
      imageState: optionalText(row["image_state"]),
      imageUpdatedAt: optionalText(row["image_updated_at"]),
      imageUrl: optionalText(row["image_url"]),
    }),
    mbid: optionalText(row["mbid"]),
    name: row["name"],
    slug: typeof row["slug"] === "string" ? row["slug"] : slug,
    spotifyUrl: optionalText(row["spotify_url"]),
    wikidataQid: optionalText(row["wikidata_qid"]),
  };
}

// ── The voiced bio: fill-empty-only write + the worklist (the entity-bio engine) ──────
//
// The bio is the entity sibling of a finding's `note`, and it inherits the note's cardinal
// safety guarantee: the agent NEVER overwrites an existing bio. `fillEmptyArtistBio` is the
// AGENT-tier fill, where the `and (bio is null or trim(bio) = '')` predicate lives in the SQL
// (not a JS check-then-act), so an operator bio — or a second agent tick — that lands between
// the handler's read and this write can never lose the race and be clobbered: the loser
// matches no row and writes nothing (mirrors `fillEmptyNote` in track-update.ts).

/**
 * Fill an artist's bio ATOMICALLY, only when it is currently empty. The bio + its
 * PROVENANCE (`bio_prompt_version`) + `bio_status = 'resolved'` land in the SAME statement,
 * gated by the fill-empty-only predicate, so the version can never describe a different bio
 * than the one it wrote and an operator bio is never clobbered. Returns whether a row was
 * written (false = a non-empty bio was already there / the entity is gone). `promptVersion`
 * is undefined for an operator-typed bio and null when the sweep fell back to its baked
 * prompt — both store NULL ("no registry prompt wrote this"). The caller has already
 * voice-gated the bio (`gateBioText`).
 */
export async function fillEmptyArtistBio(
  slug: string,
  bio: string,
  promptVersion?: number | null,
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [bio, promptVersion ?? null, new Date().toISOString(), slug],
    sql: `update artists
            set bio = ?, bio_prompt_version = ?, bio_status = 'resolved', updated_at = ?
          where slug = ?
            and (bio is null or trim(bio) = '')`,
  });

  return result.rowsAffected > 0;
}

/** One row of the bio worklist: an artist with findings but no bio yet. */
export type EntityBioWorkItem = { id: string; name: string; slug: string };

/**
 * The bio worklist: bio-empty artists whose page is INDEXABLE, oldest-first — the worklist the
 * `describe_artist` cron drains. A bare read (no writes), bounded by `limit`. Two ways in, matching
 * exactly the two ways an `/artist/<slug>` page renders:
 *
 * - a CERTIFIED artist (at least one coordinate-bearing finding) — the original floor, preserved
 *   verbatim, so a certified-but-thin artist never regresses out of the queue; OR
 * - a findings-free CATALOGUE artist whose page clears the thin-content floor
 *   ({@link ARTIST_INDEX_MIN_FINDINGS}) on renderable tracks alone — a crawl-minted page that is
 *   indexable earns a bio too, so it stops showing a bare tracklist with no dossier.
 *
 * The renderable count mirrors `listArtistSitemapRows` exactly: over the canonical `track_artists`
 * join, a track counts when its finding is coordinate-bearing (`log_id is not null`) OR when there
 * is no finding row (the anti-join's `track_id is null` complement). Bounding the findings-free arm
 * to the indexable floor caps the Firecrawl + `claude -p` cost — a wide crawl mints thousands of
 * stub artists, and only the ones with a real page should ever enter the sweep.
 */
export async function listArtistsMissingBio(limit: number): Promise<EntityBioWorkItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [ARTIST_INDEX_MIN_FINDINGS, limit],
    sql: `select a.id, a.name, a.slug
          from artists a
          where (a.bio is null or trim(a.bio) = '')
            and (
              exists (
                select 1 from track_artists ta
                join findings f on f.track_id = ta.track_id
                where ta.artist_id = a.id and f.log_id is not null
              )
              or (
                select count(*)
                from track_artists ta2
                join tracks t on t.track_id = ta2.track_id
                left join findings f2 on f2.track_id = t.track_id
                where ta2.artist_id = a.id
                  and (f2.log_id is not null or f2.track_id is null)
              ) >= ?
            )
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

/**
 * The artist's PUBLIC social links — `status IN (auto, confirmed)` only, so a
 * Firecrawl-only `candidate` never reaches the page or the `sameAs` until an
 * operator confirms it (the page-facing trust gate, RFC §2.1). Ordered by the
 * fixed display order; unknown platforms are dropped.
 */
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

/**
 * An artist's PUBLIC alternate names, name-sorted — the `alternateName` array the artist page's
 * `MusicGroup` JSON-LD carries (the MusicBrainz identity layer, the label page's `getConfirmedAliasNames`
 * twin). Filters to the trusted, real-name rows: `status in ('auto','confirmed')` (a MusicBrainz-curated
 * or operator-added alias) AND `kind = 'name'` (a "Search hint" is kept in the table but never rendered).
 * Empty for an artist with no such alias — the caller omits the key entirely.
 */
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

/**
 * The name → slug map for a track's artists (via `track_artists`), so the log
 * page can link each artist name to `/artist/<slug>` and stamp the `@id` on the
 * `byArtist` MusicGroup node. Keyed by the NORMALIZED name (`fold`: lowercased,
 * accent-folded, punctuation-collapsed) so a casing/accent/`feat.` drift between
 * the canonical `artists.name` and the `artists_json` display cache the page
 * renders from still resolves — an EXACT-name key silently dropped both the link
 * AND the `@id` on any drift. Lookups (`byArtistNode`, the log link) fold the
 * display name the same way. A name with no resolved entity is simply absent
 * (the link/`@id` degrades to plain text).
 */
export async function getArtistSlugMap(trackId: string): Promise<Record<string, string>> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select a.name, a.slug
          from artists a
          join track_artists ta on ta.artist_id = a.id
          where ta.track_id = ?`,
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

/**
 * The CANONICAL coordinate-bearing finding count for one artist — the pure
 * `track_artists` inner join (NO `artists_json` fallback). It is the artist page's
 * FINDING count (the masthead line, the dossier); the page's `indexable` gate adds
 * the catalogue total to it (findings PLUS renderable catalogue tracks), keyed off the
 * canonical join both sides so an indexable page is never orphaned from the sitemap.
 */
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

/**
 * Every ARTIST whose page clears the thin-content floor — findings or no findings. The exact twin
 * of `listAlbumSitemapRows` / `listLabelSitemapRows`: the `/artists` HUB is Fluncle's editorial
 * list (findings-joined, "every artist I've pulled a banger from"), while the SITEMAP is the
 * machine's complete map of pages that exist and may be indexed, so a crawl-minted, findings-free
 * artist with enough catalogue tracks belongs here — orphaning its page from the sitemap would
 * break the same invariant album-entity.md states.
 *
 * The floor is applied in SQL (`having`), never in the isolate: a finding counts when it is
 * coordinate-bearing (`log_id is not null`), a catalogue row is the anti-join's complement, and
 * their sum is the RENDERABLE track count the page's `indexable` keys off (the canonical
 * `track_artists` join both sides), so the two agree by construction. `lastmod` is the freshest
 * certified finding's date, undefined for an artist that carries none (catalogue rows have no
 * `added_at`, and `max` ignores nulls).
 */
export async function listArtistSitemapRows(minTracks: number): Promise<EntitySitemapRow[]> {
  const db = await getDb();
  const result = await db.execute({
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
          group by a.id
          having sum(case when findings.log_id is not null then 1 else 0 end)
               + sum(case when findings.track_id is null then 1 else 0 end) >= ?
          order by a.slug asc`,
  });

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

/** An artist tile in the unified `/artists` index — lit (certified) or unlit, one row shape for both. */
export type ArtistHubEntry = {
  /** True ⇔ the artist has ≥1 coordinate-bearing finding — the certification light, visual only. */
  certified: boolean;
  /** The artist's avatar — their OWNED master when resolved, else the raw Spotify profile image
      (undefined → the tile renders a monogram). */
  imageUrl: string | undefined;
  name: string;
  slug: string;
  /** Renderable tracks credited to the artist — findings plus the quieter rows, the tile's "N tracks". */
  trackCount: number;
};

/** The ARTISTS hub's `?page=N` + A–Z reads, over every floor-clearing artist (certified + catalogue). */
const ARTISTS_HUB_QUERY: CatalogueHubQuery<ArtistHubEntry> = {
  entity: "artists a",
  floor: ARTIST_INDEX_MIN_FINDINGS,
  from: "artists a join track_artists ta on ta.artist_id = a.id join tracks on tracks.track_id = ta.track_id",
  groupBy: "a.id",
  mapRow: (row) => ({
    certified: Boolean(row.certified),
    // The OWNED avatar master (RFC U3b) when resolved, else the raw Spotify image_url.
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
};

/**
 * One numbered page of the unified `/artists` index (the crawlable `?page=N` view) — every artist
 * Fluncle holds, certified and catalogue alike, carrying the A–Z fast lane: each present letter →
 * the page its first artist lands on.
 */
export function listArtistsHubPage(
  page: number,
  nameFilter?: string,
): Promise<CatalogueHubNumberedPage<ArtistHubEntry>> {
  // A name search hides the A–Z lane (the reader is looking an artist up by name, not browsing the
  // alphabet), so the letter arm is skipped when a filter is active.
  return listHubPage(ARTISTS_HUB_QUERY, page, !nameFilter, nameFilter);
}

/** The ARTISTS full A–Z browse — every artist with a page, certified or catalogue-only. */
// Derives its scan + floor from ARTISTS_HUB_QUERY (the web hub's), so the MCP browse and the
// /artists page can never diverge on which artists exist; only the projection differs (name inline).
const ARTISTS_BROWSE_QUERY: CatalogueBrowseQuery = {
  floor: ARTISTS_HUB_QUERY.floor,
  from: ARTISTS_HUB_QUERY.from,
  groupBy: ARTISTS_HUB_QUERY.groupBy,
  nameExpr: "a.name",
  slugExpr: ARTISTS_HUB_QUERY.slugExpr,
};

export function listArtistsBrowsePage(page: number): Promise<CatalogueBrowsePage> {
  return listCatalogueBrowsePage(ARTISTS_BROWSE_QUERY, page);
}

/** An artist chip on a graph page (the label's roster, the album's credits). */
export type ArtistChip = {
  imageUrl: string | undefined;
  name: string;
  slug: string;
};

/**
 * Every artist Fluncle has a coordinate-bearing finding from ON one label / ON one album —
 * the artist row that cross-links a graph page back into the artist half of the graph.
 * Alphabetical; an artist appears once however many findings they have here.
 *
 * `column` is a CONSTANT from the call sites below (never user input); the id is bound.
 */
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
    // The OWNED avatar master (RFC U3b) when resolved, else the raw Spotify image_url.
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

// ── THE PUBLIC CATALOGUE LIST/GET API OPS (list_artists / get_artist) ─────────────────────
//
// The artist twin of the label/album API ops (read labels.ts for the shared shape): the list is
// the SAME unified `/artists` index the web page serves — built on the shared `listHubPage` off
// `ARTISTS_HUB_QUERY`, so the API list, the web hub, and the MCP browse can never disagree on which
// artists exist. The artist hub tile projects the AVATAR; the API row carries `spotifyUrl` instead
// (the shape the CLI + SSH consume), plus the `findingCount` the tile omits — both fetched for the
// page's ≤48 slugs. `get_artist` resolves ANY artist that has a page (below-floor artists render on
// `/artist/<slug>` too, just noindex).

/** Spotify profile URLs for a BOUNDED set of artist slugs — the ONE column `list_artists` carries
 *  that the artist hub tile does not (the tile projects the avatar; the API row carries spotify). */
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

/**
 * One alphabetical page of the unified `/artists` index over the API — the `list_artists` read: the
 * SAME floor-clearing set the `/artists` web page and the MCP browse serve (all three off
 * `HUB_INCLUSION_HAVING`). Reuses the hub reader for the page + pager, and stamps each row's
 * `spotifyUrl` + `findingCount` from bounded per-page reads over the shared fragments.
 */
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

/**
 * Look up one artist by slug for the public API — the `get_artist` read. Resolves ANY artist that
 * has a page (a below-floor, crawled artist the browse index omits still renders on `/artist/<slug>`,
 * just noindex), so get is intentionally wider than the list. Counts come from `hubCountsBySlug`
 * (the same aggregates the hub gate uses), so a certified artist's list row and get read agree.
 * Undefined only when no artist carries the slug (the caller turns that into a 404).
 */
export async function getArtistListItemBySlug(slug: string): Promise<ArtistListItem | undefined> {
  const record = await getArtistBySlug(slug);

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

// ── THE MULTI-ARTIST "SOUNDS LIKE THESE" READ (list_similar_artists + the /artists results view) ──
//
// Given a handful of artist slugs, the artists sitting sonically nearest to their AVERAGE position in
// MuQ space — the "sounds like these" compare on /artists. The vector math + the exact
// `vector_distance_cos` scan live in `listSimilarArtistNeighbours` (artist-dossier.ts); these two
// projections add the counts the two consumers need, off the SHARED hub gate so `certified` /
// `trackCount` / `findingCount` agree with everything else on the page. Both fetch counts for the
// ≤12 result slugs in ONE indexed read (`hubCountsBySlugs`), never a round trip per neighbour.

/**
 * The "sounds like these" results as HUB TILES — the shape the `/artists` results view renders, so it
 * reuses the exact hub tile treatment (a certified neighbour's name lit, an uncertified one plain —
 * DESIGN.md's Unlit Rule). `certified` + `trackCount` ride the shared gate. Empty when no selected
 * slug resolves to a stored centroid (nothing to rank from).
 */
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

/**
 * The "sounds like these" results as public API rows — the `list_similar_artists` op's shape (the
 * same `ArtistListItem` the list/get ops emit). Carries `findingCount` + `spotifyUrl` alongside the
 * shared-gate `certified` + `trackCount`, both fetched for the ≤12 result slugs in bounded reads.
 * Empty when no selected slug resolves to a stored centroid.
 */
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

/**
 * The display NAMES for a bounded set of artist slugs, returned in the GIVEN slug order (an unknown
 * slug is dropped) — the "sounds like these" results view names its anchors from this ("Closest in
 * sound to X and Y."). One indexed `slug in (…)` read over the ≤6 compared slugs.
 */
export async function artistNamesBySlugs(slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) {
    return [];
  }

  const db = await getDb();
  const placeholders = slugs.map(() => "?").join(", ");
  const result = await db.execute({
    args: slugs,
    sql: `select slug, name from artists where slug in (${placeholders})`,
  });

  const bySlug = new Map(
    typedRows<{ name: string; slug: string }>(result.rows).map((row) => [row.slug, row.name]),
  );

  return slugs.flatMap((slug) => {
    const name = bySlug.get(slug);

    return name ? [name] : [];
  });
}

export function parseArtistsJson(value: string): string[] {
  try {
    const artists = JSON.parse(value) as unknown;

    if (Array.isArray(artists)) {
      return artists.filter((artist): artist is string => typeof artist === "string");
    }
  } catch (error) {
    logEvent("warn", "artists.parse-artists-json-failed", { error });
    return [];
  }

  return [];
}

// ── Artist entity ────────────────────────────────────────────────────────────
// A canonical artist slug: real-name kebab-cased, lowercase, diacritics stripped,
// only [a-z0-9-] characters. Empty result falls back to the first 8 chars of the
// artist's surrogate id at call-site (the caller supplies the fallback).
export function toArtistSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // strip diacritics (Unicode category Mn/Mc/Me)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alnum → single hyphen
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

// Mint a unique slug for an artist name by checking the `artists` table for
// collisions. Tries the base slug first, then `{base}-2` … `{base}-64`, then
// falls back to `{base}-{id[:8]}` (guaranteed unique since id is a fresh UUID).
// The collision check is done against the DB, so concurrent inserts on the same
// name can still collide at the unique constraint level — callers should handle
// that via an upsert.
async function mintArtistSlug(id: string, name: string): Promise<string> {
  const db = await getDb();
  const base = toArtistSlug(name) || id.slice(0, 8);

  // Try the base slug first.
  const first = await db.execute({
    args: [base],
    sql: `select 1 from artists where slug = ? limit 1`,
  });

  if (first.rows.length === 0) {
    return base;
  }

  // Try salt-suffixed variants.
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

  // Final fallback: base + first 8 chars of the surrogate id (unique by construction).
  return `${base}-${id.slice(0, 8)}`;
}

/**
 * THE LINK STEP — the crawled half of the `track ↔ artist` edge, and the third member of a
 * family: `album_id` and `label_id` already work exactly this way (docs/album-entity.md).
 *
 *   MINT an entity only off a CERTIFIED FINDING, then LINK every track — certified or not —
 *   whose entity already has a row.
 *
 * `upsertTrackArtists` below is the MINT half, and it runs off Spotify artist IDs at publish.
 * A CRAWLED track has no Spotify anchor when it lands, so it got no `track_artists` row at all,
 * and its artist was therefore reachable only through the raw `artists_json` names. That was
 * fine while nothing asked the question — and it stopped being fine the moment `/artist/<slug>`
 * had to show the rest of an artist's catalogue, because answering THAT through `artists_json`
 * is a full scan of a table with no bound on its growth (AGENTS.md forbids exactly this).
 *
 * So: match a track's credited names against the artists Fluncle has ALREADY certified, and
 * stamp the edge. The bound survives — an artist Fluncle has never found a banger from still
 * has no entity, no page, and no row here, precisely as an album he has never touched has none.
 * What this earns is the artist he HAS certified: their crawled catalogue becomes reachable by
 * an INDEXED SEEK (`track_artists_artist_id_idx`) at any catalogue size.
 *
 * What it deliberately does NOT do is make a catalogue track countable as a finding. Every read
 * that means "finding" inner-joins `findings … log_id is not null` (`countArtistFindings`,
 * `listArtists`, `listArtistsByLabel`, the sitemap, the `/artists` index), so a link added here
 * moves none of them. `artists.test.ts` pins that: the counts are byte-identical before and
 * after a catalogue link lands.
 *
 * Idempotent (the composite PK absorbs a re-run), and bounded per call. `trackIds` scopes it to
 * a just-written batch — how the crawler calls it, per release, so the edge is live within the
 * tick rather than only after the next deploy's reconcile.
 */
export async function linkTracksToArtistEntities(trackIds?: string[]): Promise<number> {
  const db = await getDb();
  const scoped = trackIds && trackIds.length > 0;

  if (trackIds && trackIds.length === 0) {
    return 0;
  }

  // `json_each` explodes `artists_json` into one row per credited name; `credit.key` is the
  // 0-based array index, which is exactly the 1-based `position` the column wants. The name
  // match is the same case-insensitive fold every other entity uses to relate a raw captured
  // string to its normalized twin.
  const result = await db.execute({
    args: scoped ? trackIds : [],
    sql: `insert or ignore into track_artists (track_id, artist_id, position)
          select tracks.track_id, a.id, credit.key + 1
          from tracks
          join json_each(tracks.artists_json) credit
          join artists a on a.name = credit.value collate nocase
          ${scoped ? `where tracks.track_id in (${trackIds.map(() => "?").join(", ")})` : ""}`,
  });

  return result.rowsAffected;
}

/**
 * Stamp `track_artists.role = 'remixer'` for the remixer(s) a track's TITLE names, over a batch of
 * track ids (RFC label-lineage-remixer, U2). Fill-empty-only (`role is null`) and idempotent — a
 * re-run over already-stamped rows touches nothing, and it never DOWNGRADES a role. Derivation is
 * `deriveRemixerNames` (track-match.ts), the same pure function the JSON-LD emit reads, so the
 * column and the markup agree by construction.
 *
 * Runs after the track_artists edge is minted — from the publish path (`upsertTrackArtists`), the
 * crawler (`linkTracksToArtistEntities`), and the Spotify-anchor step — plus the deploy backfill
 * (`scripts/backfill-remixer-roles.ts`) for history. It reads the title + credited names off the
 * `tracks` row itself, so no caller threads the title through. NEVER guesses beyond an exact fold
 * match: a remixer with no linked `artists` row (uncertified) leaves no row to stamp. Returns the
 * count of rows stamped. Best-effort by contract — the callers wrap it so a failure never blocks
 * the write it follows.
 */
export async function stampRemixerRoles(trackIds: string[]): Promise<number> {
  if (trackIds.length === 0) {
    return 0;
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");

  // One read: every UNSTAMPED (track, linked-artist) edge in the batch, carrying the track's title
  // + `artists_json` so the derivation runs per track without a second query. Bounded by the batch
  // (a crawler release is a handful of tracks; the publish path passes one).
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

  let stamped = 0;

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

      const result = await db.execute({
        args: [artist.artistId, trackId],
        sql: `update track_artists set role = 'remixer'
              where artist_id = ? and track_id = ? and role is null`,
      });

      stamped += result.rowsAffected;
    }
  }

  return stamped;
}

// Upsert artists + track_artists for a track that was just inserted. Called at
// ingest (publish path), by the crawler's Spotify-anchor step, and by the backfill.
// Idempotent: existing artist rows are matched by `spotify_artist_id` and their
// `name` + `updated_at` are updated if the name changed; `track_artists` rows are
// matched by the composite PK (track_id, artist_id). Silently no-ops when
// `artistNames` is empty (a track with no parseable artist data, or a dry-run caller).
//
// `options.fillImages` (default true) controls the best-effort Spotify avatar fetch. The
// publish path leaves it on so a freshly-logged artist has its avatar the moment its page can
// be seen. The CRAWLER passes `false` and lets the batched `backfill-artist-images` sweep (the
// `fluncle-artist-sweep` cron) fill its avatar in one call per 50 ids — per-track avatar calls at
// crawl time would be uncounted Spotify load (outside the anchor breaker) for one image, spent on
// the hot path. The graph edge is written either way; only the avatar fetch defers to the sweep.
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

  for (let i = 0; i < artistNames.length; i++) {
    const name = artistNames[i];
    const spotifyArtistId = spotifyArtistIds[i];
    const position = i + 1;

    if (!name) {
      continue;
    }

    // --- Resolve or mint the artist row ---
    let artistId: string | undefined;

    if (spotifyArtistId) {
      // Look up by Spotify artist ID first (the most reliable key).
      const existing = await db.execute({
        args: [spotifyArtistId],
        sql: `select id from artists where spotify_artist_id = ? limit 1`,
      });

      if (existing.rows.length > 0) {
        const row = existing.rows[0] as Record<string, unknown>;
        const id = row["id"];
        artistId = typeof id === "string" ? id : undefined;

        if (artistId) {
          // Update name + timestamp in case the canonical name drifted on Spotify.
          await db.execute({
            args: [name, nowIso, artistId],
            sql: `update artists set name = ?, updated_at = ? where id = ?`,
          });
        }
      }
    }

    if (!artistId) {
      // Not found by Spotify ID — check by name as a secondary key.
      const byName = await db.execute({
        args: [name],
        sql: `select id from artists where name = ? limit 1`,
      });

      if (byName.rows.length > 0) {
        const row = byName.rows[0] as Record<string, unknown>;
        const id = row["id"];
        artistId = typeof id === "string" ? id : undefined;

        if (artistId && spotifyArtistId) {
          // Fill in the Spotify ID now that we have it.
          await db.execute({
            args: [spotifyArtistId, nowIso, artistId],
            sql: `update artists set spotify_artist_id = ?, updated_at = ? where id = ? and spotify_artist_id is null`,
          });
        }
      }
    }

    if (!artistId) {
      // Brand new artist — mint a surrogate id + slug and insert the row.
      const newId = randomUUID();
      const slug = await mintArtistSlug(newId, name);
      const spotifyUrl = spotifyArtistId
        ? `https://open.spotify.com/artist/${spotifyArtistId}`
        : null;

      await db.execute({
        args: [newId, spotifyArtistId ?? null, name, slug, spotifyUrl, nowIso, nowIso],
        sql: `insert into artists (id, spotify_artist_id, name, slug, spotify_url, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?, ?)
              on conflict(spotify_artist_id) do update set
                name = excluded.name,
                updated_at = excluded.updated_at`,
      });

      // Re-fetch the id in case of a concurrent insert that triggered the ON CONFLICT.
      const fresh = await db.execute({
        args: spotifyArtistId ? [spotifyArtistId] : [name],
        sql: spotifyArtistId
          ? `select id from artists where spotify_artist_id = ? limit 1`
          : `select id from artists where name = ? limit 1`,
      });

      const freshRow = fresh.rows[0] as Record<string, unknown> | undefined;
      const freshId = freshRow?.["id"];
      artistId = typeof freshId === "string" ? freshId : newId;
    }

    // --- Upsert track_artists ---
    await db.execute({
      args: [trackId, artistId, position],
      sql: `insert into track_artists (track_id, artist_id, position)
            values (?, ?, ?)
            on conflict(track_id, artist_id) do update set
              position = excluded.position`,
    });
  }

  // Fill the canonical Spotify avatar for any of this track's artists that lacks one
  // (a freshly-minted artist always does). Best-effort: a Spotify hiccup must never
  // block the fast synchronous add — the image backfill sweeps up anything missed. The
  // crawler opts out (`fillImages: false`); its artists' avatars are filled by the sweep.
  if (options?.fillImages ?? true) {
    try {
      await fillMissingArtistImages(spotifyArtistIds);
    } catch (error) {
      logEvent("warn", "artists.image-fill-failed", { error, trackId });
    }
  }
}

/**
 * MINT a fresh artist row keyed on a MusicBrainz artist id — the identity-true mint the MB credit
 * sweep (`backfill_artist_credits`, RFC artist-primary-capture slice 1b) reaches for LAST, after the
 * sweep has ruled out both an exact-mbid match AND an unambiguous name ADOPT (see the resolver in
 * `backfill-artist-credits.ts`). It is the SIBLING of `upsertTrackArtists`'s mint block above and
 * shares its slug primitive (`mintArtistSlug`), but keys on a DIFFERENT identity: a real MB artist
 * id, not a Spotify id or a bare name. That distinction is the whole licence to mint — the slice-0
 * backfill mints NOTHING because a bare name is not enough identity to create an entity, whereas an
 * MB artist id IS identity (a curated, dereferenceable MBID), so a row born from one is honest.
 *
 * WHY A DEDICATED HELPER, not `upsertTrackArtists`: that path resolves by `spotify_artist_id`/name
 * and fires a best-effort Spotify avatar fetch per call — neither fits an mbid-keyed catalogue-graph
 * fill (the avatar is the `backfill-artist-images` sweep's job). There is NO pre-existing mbid mint
 * path to reuse — `artists.mbid` is only ever set today by `artist-resolution.ts` as a `coalesce`
 * UPDATE on an already-existing certified artist, never at CREATE. So this is the one canonical mbid
 * mint, colocated with its Spotify twin. Returns the new artist id. Writes identity only — no edge,
 * no avatar, no certification.
 */
export async function mintArtistByMbid(name: string, mbid: string): Promise<string> {
  const db = await getDb();
  const newId = randomUUID();
  const slug = await mintArtistSlug(newId, name);
  const nowIso = new Date().toISOString();

  await db.execute({
    args: [newId, mbid, name, slug, nowIso, nowIso],
    sql: `insert into artists (id, mbid, name, slug, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });

  return newId;
}

/**
 * ADOPT a MusicBrainz artist id onto an EXISTING artist row that has none — the rung the MB credit
 * sweep takes when a credited name folds UNAMBIGUOUSLY onto an artist Fluncle already holds (a
 * Spotify-keyed row minted at publish/anchor, `mbid` still NULL) but which slice 0 could not link
 * because it lived inside a compound credit string ("Sub Focus & Dimension"). Adopting instead of
 * minting is what stops this sweep becoming a mass generator of split-identity duplicates (the class
 * the label-merge op cleans for labels — artists have no merge op at all). NON-CLOBBERING via
 * `coalesce` + a `mbid is null` guard (never overwrite an mbid already there — a wrong merge is
 * unrecoverable), the `artist-resolution.ts` precedent; bumps `updated_at` because a resolved MBID is
 * a public identity fact (it feeds the artist page's `sameAs` / KG anchor).
 */
export async function adoptArtistMbid(artistId: string, mbid: string): Promise<void> {
  const db = await getDb();
  const nowIso = new Date().toISOString();

  await db.execute({
    args: [mbid, nowIso, artistId],
    sql: `update artists set mbid = coalesce(mbid, ?), updated_at = ?
          where id = ? and mbid is null`,
  });
}

/**
 * Fill `artists.image_url` for the given Spotify artist ids that still lack an image.
 * Only the null-image rows are fetched (one batched Spotify `/v1/artists` call), so a
 * repeat over already-imaged artists costs a single indexed read and no API call —
 * the shared idempotent core of the create-time fill and the image backfill. Returns
 * how many rows were newly filled.
 */
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
              where spotify_artist_id in (${placeholders}) and image_url is null`,
      })
    ).rows,
  );

  if (missing.length === 0) {
    return 0;
  }

  const images = await fetchArtistImages(missing.map((row) => row.spotify_artist_id));
  const nowIso = new Date().toISOString();
  let filled = 0;

  for (const row of missing) {
    const url = images.get(row.spotify_artist_id);

    if (!url) {
      continue;
    }

    await db.execute({
      args: [url, nowIso, row.id],
      sql: `update artists set image_url = ?, updated_at = ? where id = ? and image_url is null`,
    });
    filled += 1;
  }

  return filled;
}

// ── The identity graph: artist_socials (Unit 5) ──────────────────────────────

export type ArtistSocialStatus = "auto" | "candidate" | "confirmed";
export type ArtistSocialSource = "musicbrainz" | "firecrawl" | "operator";

/** One `artist_socials` row, in the shape the admin surfaces read. */
export type ArtistSocial = {
  id: string;
  artistId: string;
  platform: ArtistSocialPlatform;
  url: string;
  source: ArtistSocialSource;
  status: ArtistSocialStatus;
  /** ISO stamp of when this link was discovered/added — the fresh-links queue's oldest-first anchor. */
  createdAt: string;
  /** ISO stamp of when the operator last acknowledged THIS link, or null when it hasn't been
   *  reviewed yet (a fresh insert, or a machine re-resolve that changed its URL). Null = fresh. */
  reviewedAt: string | null;
};

/** One artist in the review queue, carrying all of its socials for the operator's glance. */
export type ArtistSocialsQueueItem = {
  id: string;
  name: string;
  slug: string;
  spotifyUrl: string | null;
  socials: ArtistSocial[];
};

// Narrow an `unknown` DB cell to a string (a non-string — NULL, number — becomes ""),
// so the row mappers never `String()` an object (oxlint's no-base-to-string).
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const KNOWN_PLATFORMS = new Set<string>(ARTIST_SOCIAL_PLATFORMS);

function isArtistSocialPlatform(value: string): value is ArtistSocialPlatform {
  return KNOWN_PLATFORMS.has(value);
}

// Map a raw DB row to a typed `ArtistSocial`. Platform/status/source are validated
// against their enums; an unknown value is coerced to a safe default so a malformed
// row never crashes the queue (it just reads oddly, which the operator can fix).
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

/**
 * The `/admin/artists` review queue: every artist that still has a `candidate` social
 * to confirm. Each artist carries ALL its socials so the operator sees the whole
 * identity graph in one card. Bounded so a huge archive never blows the payload; the
 * queue is small by construction (most socials arrive `auto` from MusicBrainz — the
 * RFC's design note).
 *
 * `fresh` widens the narrowing to the board's fresh-links rule (`reviewed_at IS NULL`),
 * so an artist whose only fresh links are trusted `auto` rows — no candidate anywhere —
 * still surfaces. The default stays candidate-only for the /admin attention count.
 */
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

export type ArtistOverviewItem = ArtistSocialsQueueItem & {
  /** Coordinate-bearing findings featuring this artist (the canonical track_artists join). */
  findingCount: number;
};

/** Whether an artist has any link the operator hasn't reviewed yet — the single needs-a-look
 *  predicate, shared by the overview UI and the /admin attention count. Review now lands on the
 *  LINK (docs/artist-relationship.md): a link is fresh iff its `reviewedAt` is null. */
export function artistNeedsLook(socials: readonly { reviewedAt: string | null }[]): boolean {
  return socials.some((social) => social.reviewedAt === null);
}

/** An artist's still-unreviewed links (`reviewedAt === null`), oldest-first — the fresh-links
 *  section's per-artist group. Shared by the board's fresh-links section so the "what's fresh"
 *  rule lives in one place. */
export function unreviewedSocials<T extends { createdAt: string; reviewedAt: string | null }>(
  socials: readonly T[],
): T[] {
  return socials
    .filter((social) => social.reviewedAt === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// The two platforms a finding's caption tags today (lib/server/mentions.ts weaves a mention line
// ONLY for `tiktok` + `youtube`, and ONLY from `auto`/`confirmed` handles). So a fresh link on one
// of these — once approved — feeds the caption mention loop the moment a finding's video posts.
// Kept in lockstep with `MentionPlatform` in mentions.ts; these lead the high-priority section.
const MENTION_LOOP_PLATFORMS = new Set<ArtistSocialPlatform>(["tiktok", "youtube"]);

/** One fresh (unreviewed) link paired with the artist it belongs to — a row in the fresh-links queue. */
export type FreshLinkEntry = {
  artist: ArtistOverviewItem;
  social: ArtistSocial;
};

/** The fresh-links review queue split by mention-loop impact (docs/artist-relationship.md §review queue). */
export type FreshLinksPartition = {
  /**
   * Fresh links whose artist has at least one finding — these GATE the caption mention loop, so
   * they lead the board. Mention-loop platforms (tiktok, youtube) sort first, then the rest; then
   * by artist name, then oldest-first.
   */
  highPriority: FreshLinkEntry[];
  /**
   * Every other fresh link (catalogue-only artists, no posting implication yet) — in the queue's
   * prior order: artist name (the loader's order), then oldest-first within an artist.
   */
  everythingElse: FreshLinkEntry[];
};

/** Order a HIGH-PRIORITY fresh link: mention-loop platforms first, then artist name, then oldest. */
function compareHighPriorityLink(left: FreshLinkEntry, right: FreshLinkEntry): number {
  const leftMention = MENTION_LOOP_PLATFORMS.has(left.social.platform) ? 0 : 1;
  const rightMention = MENTION_LOOP_PLATFORMS.has(right.social.platform) ? 0 : 1;

  if (leftMention !== rightMention) {
    return leftMention - rightMention;
  }

  const byName = left.artist.name.localeCompare(right.artist.name);

  if (byName !== 0) {
    return byName;
  }

  return left.social.createdAt.localeCompare(right.social.createdAt);
}

/**
 * Partition every fresh (unreviewed) artist-social link into the two review sections the board
 * renders. A link is HIGH PRIORITY when its artist has at least one finding (`findingCount > 0`,
 * the canonical coordinate-bearing count that the whole codebase means by "finding"): an approved
 * handle for a findings-bearing artist immediately feeds the caption mention loop
 * (lib/server/mentions.ts tags only `auto`/`confirmed` handles when a finding's video posts), while
 * a catalogue-only artist's link carries no posting implication yet.
 *
 * SERVER-AUTHORED so the split never depends on what a page happens to load: each input item already
 * carries its server-computed `findingCount`, and the board's fetch (`listAllArtistsWithSocials`) is
 * unbounded, so the high-priority section is COMPLETE and leads regardless of row order. Within it,
 * the two mention-loop platforms (tiktok, youtube) sort first — the links that gate a caption today
 * read at the top. `everythingElse` preserves the queue's prior order (the loader is name-sorted and
 * `unreviewedSocials` is oldest-first, so pushing in iteration order yields name-then-oldest, exactly
 * as the section read before the split). The row SET is unchanged — this is a partition + ordering
 * change, not a filter: every link `unreviewedSocials` surfaced still surfaces.
 */
export function partitionFreshLinks(artists: readonly ArtistOverviewItem[]): FreshLinksPartition {
  const highPriority: FreshLinkEntry[] = [];
  const everythingElse: FreshLinkEntry[] = [];

  for (const artist of artists) {
    const fresh = unreviewedSocials(artist.socials);

    if (fresh.length === 0) {
      continue;
    }

    const bucket = artist.findingCount > 0 ? highPriority : everythingElse;

    for (const social of fresh) {
      bucket.push({ artist, social });
    }
  }

  highPriority.sort(compareHighPriorityLink);

  return { everythingElse, highPriority };
}

// ── The `/admin/artists` board reads (paginated) ────────────────────────────────────────────
// The board used to be ONE unbounded query — every artist × every social row, a correlated
// 3-table finding-count scalar subquery re-run PER OUTPUT ROW, ordered so the whole result had to
// materialise and sort, serialized whole into the SSR document and refetched whole on every focus.
// The crawler mints artists without end, so that read grew without bound (measured: a 24.8 MB SSR
// document). It is replaced by three bounded shapes: a keyset PAGE read (`listArtistsPage`), the
// server-side FRESH-LINKS work queue (`listFreshLinks`), and a shared HYDRATE step that attaches
// socials + a GROUPED (once-per-page, never per-row) finding count. A socialless artist still
// lists so a link can be added; the finding count survives as a per-artist number.

/** One page of the board — a bounded slice of the name-sorted artist list. */
export type ArtistsPage = {
  items: ArtistOverviewItem[];
  /** Opaque keyset cursor for the next page, or null at the end. */
  nextCursor: string | null;
  /** Total artists matching the (optional) search — the board's honest header count. */
  totalCount: number;
};

/** The board's page read query: a keyset slice by (name, id), optionally name-filtered. */
export type ArtistsPageQuery = { cursor?: string; limit?: number; search?: string };

const ARTISTS_PAGE_SIZE = 50;
const ARTISTS_PAGE_MAX = 100;

// The (name, id) keyset cursor. It never rides a URL — it lives in the react-query key + the
// serverFn body — so a plain separator-joined string is enough; the id is a UUID (no separator),
// so `lastIndexOf` recovers the split even if a name somehow carried the separator character.
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

// Escape LIKE metacharacters so a typed name matches as a literal substring (the old client
// `includes`), not as a pattern — used with `like ? escape '\'`.
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The base artist columns the board hydrates from — one row per artist, before socials/counts. */
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

// Attach each artist's socials (sorted by platform IN THE ISOLATE — the SQL no longer sorts them)
// and its coordinate-bearing finding count. Two bounded batch reads over the ≤N page ids: the
// socials by `artist_socials_artist_id_idx`, the counts GROUPED ONCE over `track_artists ⋈ findings`
// (log_id not null) via `track_artists_artist_id_idx` — never the old per-output-row correlated
// scalar. So the cost is per PAGE, not per artist × social.
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

/**
 * The board's PAGE read — a keyset slice of every artist Fluncle features, name-sorted, each with
 * its full socials list (confirmed, auto, candidate) and finding count. The stable MANAGEMENT
 * surface: an artist never drops off for being resolved, so the operator can edit/add/remove a link
 * any time. Bounded by construction (≤{@link ARTISTS_PAGE_SIZE} artists, keyset on `(name, id)` over
 * `artists_name_idx`) and searched server-side, so the crawler minting artists without end never
 * grows this read. A socialless artist still lists (the hydrate left-joins its socials).
 */
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

  // Peek one past the page so we learn whether a next page exists (and its cursor) in one read.
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

/** The board's Fresh-links WORK QUEUE, read server-side: the artists carrying an unreviewed link
 *  (with their full socials + finding count so the mention-loop split can run), plus the true
 *  total so any overflow past the cap stays visible. */
export type FreshLinksData = {
  /** The capped set of artists with unreviewed links, name-sorted (the priority split re-orders). */
  artists: ArtistOverviewItem[];
  /** Every artist with at least one unreviewed link — so the board can flag work beyond the cap. */
  total: number;
};

/**
 * The most fresh-link artists the board renders at once. Generous — the fresh set is the operator's
 * live work, not the whole archive — but bounded on the same principle as
 * {@link LABEL_REVIEW_QUEUE_LIMIT}: a crawl minting links faster than they are reviewed must never
 * serialize an unbounded work list into the SSR document (the 24.8 MB failure this rework fixes).
 * The full list drains as he reviews; {@link FreshLinksData.total} surfaces anything past the cap so
 * nothing hides.
 */
export const FRESH_LINKS_LIMIT = 100;

/**
 * Read the fresh-links work queue: every artist with an unreviewed (`reviewed_at IS NULL`) link,
 * oldest-first by its oldest fresh link (the queue's anchor), capped at {@link FRESH_LINKS_LIMIT},
 * then hydrated with full socials + finding count so {@link partitionFreshLinks} can split it by
 * mention-loop impact. The fresh scan rides `artist_socials_unreviewed_idx`; the cap bounds the
 * payload. Returned name-sorted so the "Everything else" group reads A–Z as it did before.
 */
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
  /** The oldest unseen link's created stamp — the queue's oldest-first anchor. */
  anchorAt: string;
  /** How many links are new since the operator last reviewed this artist. */
  pending: number;
};

/**
 * The most artists with unreviewed links the /admin attention queue will ever carry — the exact
 * twin of {@link LABEL_REVIEW_QUEUE_LIMIT}, and for the exact same reason. The crawler mints
 * `artist_socials` links continuously (a resolver pass fills a fresh handle per platform per
 * artist), so an uncapped one-row-per-artist read is hundreds of `AttentionItem`s in the /admin
 * SSR payload, the react-query cache, and `fluncle admin queue` — a cockpit you cannot read. So the
 * queue takes a WORKING SET, oldest-first, and `/admin/artists` (the fresh-links section) stays the
 * station where the full list is reviewed. Capping the queue hides no work; it stops one source
 * from drowning the other five.
 */
export const ARTIST_REVIEW_QUEUE_LIMIT = 25;

// The /admin attention row's honest read: one row per artist that has UNREVIEWED links
// (`reviewed_at IS NULL`) — a fresh link the operator hasn't looked at yet — with the count of
// those links and the oldest one's stamp (the queue's oldest-first anchor), capped at
// {@link ARTIST_REVIEW_QUEUE_LIMIT} oldest-first. Mirrors artistNeedsLook; the pure model turns each
// into a "Review →" deep-link onto /admin/artists (the manage surface, where the fresh-links section
// lives), so the queue surfaces the work and the page does it. Review lands on the LINK, so a single
// fresh Twitch link surfaces without re-flagging the whole already-reviewed artist.
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

// Fetch one social row by id, or undefined. Small helper for the operator writes,
// which return the fresh row for the board's optimistic patch.
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

/** Thrown when an operator write targets an artist_social id that isn't there. */
export class ArtistSocialNotFoundError extends Error {
  constructor(socialId: string) {
    super(`No artist social with id ${socialId}`);
    this.name = "ArtistSocialNotFoundError";
  }
}

/**
 * Promote a `candidate` social to `confirmed` — the operator's one-tap glance that
 * lets a Firecrawl-sourced link onto the public artist page. Idempotent for an already
 * `confirmed`/`auto` row (a no-op). Returns the fresh row.
 */
export async function confirmArtistSocial(socialId: string): Promise<ArtistSocial> {
  const existing = await getArtistSocialById(socialId);

  if (!existing) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  // Defense for candidates written by OTHER units (the Firecrawl → candidate ingestion,
  // Unit 2.1): never promote a stored URL whose scheme isn't http(s) onto the public page.
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

/** Thrown when add_artist_social gets a platform outside the enum, a malformed URL, or a non-http(s) scheme. */
export class InvalidArtistSocialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArtistSocialError";
  }
}

/**
 * Guard a social URL's scheme: parse it and allow ONLY `http:`/`https:`, returning the
 * trimmed, validated string. A `javascript:`/`data:`/`vbscript:` URL rendered into an
 * admin `<a href>` is click-to-execute stored XSS in the admin origin (React does NOT
 * sanitize `href`), and a promoted candidate carries it to the public artist page — so
 * every write AND the render run through this. Throws `InvalidArtistSocialError` on an
 * empty string, an unparseable URL, or a disallowed scheme.
 */
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

/**
 * Add (or replace) an artist's social by platform — the operator's add in the Manage-links
 * dialog. An operator-entered link is trusted, so it lands `source=operator`,
 * `status=confirmed` (it renders publicly at once) and BORN REVIEWED (`reviewed_at = now`) —
 * the operator just wrote it, so it never surfaces in the fresh-links queue. Upserts on the
 * `(artist_id, platform)` unique index. Returns the fresh row.
 */
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

/**
 * Mark an artist's WHOLE link list as reviewed — the operator's "Looks good". Bulk-stamps
 * `reviewed_at = now` on every one of the artist's still-unreviewed links (clearing needs-a-look
 * until a NEW link arrives), AND promotes any surviving `candidate` links to `confirmed`:
 * reviewing the list IS the trust gate (a wrong candidate is deleted in Manage links before this),
 * so what's left is good to go public. This is the per-artist bulk of the per-link `reviewArtistSocial`.
 * Idempotent. Returns the count of candidates promoted.
 */
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

/**
 * Mark ONE link as reviewed — the operator's "approve" in the board's fresh-links section.
 * Stamps `reviewed_at = now` (the link leaves the fresh-links queue) AND, mirroring "Looks good"
 * at the link grain, promotes it `candidate → confirmed` so approving a fresh Firecrawl link also
 * lets it onto the public artist page. Idempotent. Returns the fresh row.
 */
export async function reviewArtistSocial(socialId: string): Promise<ArtistSocial> {
  const existing = await getArtistSocialById(socialId);

  if (!existing) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  // Reviewing a link is the trust gate onto the public page — never promote a stored URL whose
  // scheme isn't http(s) (the same defense confirmArtistSocial applies).
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

/**
 * Correct an artist social's URL AND approve it in one act — the operator's inline edit in the
 * board's fresh-links section (fixing a resolver miss without leaving the row: a
 * `music.youtube.com/search` page or a label's Bandcamp the resolver mistook for the artist).
 *
 * Validates + normalizes the entered URL against the row's KNOWN platform through the resolver's
 * own helpers (`validateSocialUrlForPlatform` → `classifyMbUrl` + `normalizeProfileUrl`): a
 * YouTube row rejects an instagram.com URL; a pasted deep link collapses to its profile root
 * where it can, or is rejected with an honest reason (thrown as `InvalidArtistSocialError`).
 *
 * On success the row becomes OPERATOR-OWNED and public in one write, mirroring `add_artist_social`
 * / #544's operator write path: `source=operator`, `status=confirmed`, and BORN REVIEWED
 * (`reviewed_at = now`) — so the corrected link leaves the fresh-links queue and is immune to a
 * later re-resolve (persistResolution skips operator/confirmed rows). Returns the fresh row.
 */
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

/** Remove one artist social by id (the operator's inline delete). Idempotent. */
export async function removeArtistSocial(socialId: string): Promise<void> {
  const db = await getDb();

  await db.execute({ args: [socialId], sql: `delete from artist_socials where id = ?` });
}
