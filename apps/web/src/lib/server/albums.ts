// The album entity's backing functions — the structural twin of `labels.ts` (read that
// module first; this one is deliberately its mirror), consumed by the public
// `/album/<slug>` + `/albums` route loaders, the sitemap, and the publish path's upsert.
//
// An album is the fourth node of Fluncle's graph (log ↔ artist ↔ label ↔ album) and the
// SIMPLEST of them: it carries no operator control at all. A label has a seed state
// because a label is a crawl seed; an album is not, so there is nothing to rule on, no
// `seed_state`, no `ruled_at`, and no `/admin/albums` station.
//
// Identity is the SLUG, not the name. `tracks.album` stays the raw captured string forever
// (the audit trail and the re-normalization input); an album row is related to it by
// `slugify(tracks.album) = albums.slug`, and `tracks.album_id` is the indexed pointer the
// pages read by. SQLite has no `slugify`, so the fold happens here in TS — but only ever
// over a BOUNDED read (one row per DISTINCT album on a certified finding), never over the
// catalogue. Every catalogue-sized read goes through the `album_id` index.
//
// A row is minted two ways: off a certified finding (the publish path, folded on `slug`), and
// INLINE by the catalogue crawler for the release it walks (folded on `release_group_mbid`, slug
// as the fallback). So an album entity exists for a catalogue-only record too; the `/albums`
// editorial index stays findings-bounded, the crawl-minted rows reach a page only through the
// renderable-track thin-content gate. See docs/album-entity.md.

import { randomUUID } from "node:crypto";
import { type AlbumDetail, type AlbumListItem } from "@fluncle/contracts";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { bestAlbumCoverUrl } from "../media";
import { getDb, typedRows } from "./db";
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
  listCatalogueBrowsePage,
  listHubPage,
} from "./labels";

// The thin-content gate for album pages: an `/album/<slug>` page indexes (and enters the
// sitemap) only with this many RENDERABLE tracks or more — its findings plus the quieter
// rows beneath them, because both are real content on the page. Below it the page still
// serves 200 (deep links + link equity) but is `noindex, follow` and stays out of the
// sitemap. The threshold is the `ARTIST_INDEX_MIN_FINDINGS` precedent's value; what
// differs is WHAT is counted, and that is the point: an album Fluncle found one banger on
// is a thin page TODAY and a genuine tracklist page once the rest of the record is there.
export const ALBUM_INDEX_MIN_TRACKS = 3;

/** A row from the `albums` table (snake_case columns). */
type AlbumRow = {
  created_at: string;
  id: string;
  name: string;
  slug: string;
  updated_at: string;
};

/** The canonical album identity record the pages + JSON-LD read. */
export type AlbumRecord = {
  /**
   * The album's voiced public bio (the entity sibling of a finding's `note`), or undefined
   * when none is authored yet. Optional so the callers that mint a bare `AlbumRecord` need
   * not carry it; the surfacing reads it off `getAlbumBySlug`. See lib/server/bio.ts.
   */
  bio?: string;
  id: string;
  name: string;
  /**
   * The album's earliest track release date (`min(tracks.release_date)` across the record's rows),
   * or undefined when no track carries one — the MusicAlbum JSON-LD's `datePublished`.
   */
  releaseDate?: string;
  /**
   * The MusicBrainz release-group MBID (`albums.release_group_mbid`), or undefined — the album's
   * off-site identity anchor the JSON-LD emits into `sameAs`.
   */
  releaseGroupMbid?: string;
  slug: string;
  /** The album's barcode (`albums.upc`), or undefined — the MusicAlbum JSON-LD's `gtin13`. */
  upc?: string;
};

const ALBUM_COLUMNS = "id, name, slug, created_at, updated_at";

/**
 * The join key between a raw `tracks.album` string and an `albums` row. Returns
 * `undefined` for a blank or all-punctuation album name, which is exactly the set of
 * strings that must NOT mint an album row.
 */
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

/**
 * Ensure an `albums` row exists for one raw album string, and return its id.
 *
 * TWO IDENTITIES, resolved in priority order:
 *
 *   1. THE RELEASE-GROUP MBID (`release_group_mbid`), when the caller has one — the catalogue
 *      crawler does, off MusicBrainz's `inc=release-groups`. A release group is MusicBrainz's
 *      album abstraction over its pressings, so it is the STABLE fold key: two pressings of one
 *      record (different titles, different slugs) resolve to the SAME row. Resolved FIRST, so an
 *      album already folded on this release group is reused outright.
 *   2. THE SLUG (`slugify(name)`) — the display identity, and the fallback fold when no mbid
 *      exists (the publish path passes none; a crawled release with no release group has none).
 *
 * When a caller carries an mbid and the row it lands on (minted this call, or pre-existing off
 * the slug because a finding minted it first) has none yet, the mbid is ADOPTED onto that row —
 * fill-empty-only, so a row already folded on a DIFFERENT release group is never rewritten and
 * the unique index guards a genuine collision. That adoption is what lets a finding-minted album
 * and the crawler's later pressings collapse into one row instead of duplicating.
 *
 * Idempotent and NON-CLOBBERING on the display `name` (first spelling seen wins). A blank album
 * name mints nothing and returns `undefined` (an album row's `name` is NOT NULL, so an mbid with
 * no name still cannot mint — it can only RESOLVE an existing row). Called best-effort, so a
 * failure here must never block an add — the one-off `backfill-album-graph.ts` backstops history.
 */
export async function ensureAlbum(
  raw: string | null | undefined,
  releaseGroupMbid?: null | string,
): Promise<string | undefined> {
  const db = await getDb();
  const mbid =
    typeof releaseGroupMbid === "string" && releaseGroupMbid.trim()
      ? releaseGroupMbid.trim()
      : null;

  // 1. mbid-first: an album already folded on this release group wins, whatever its slug.
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

  // 2. the slug path — mint (or reuse) by the display identity. Requires a real name.
  const slug = albumSlug(raw);

  if (!slug || typeof raw !== "string") {
    return undefined;
  }

  const now = new Date().toISOString();

  await db.execute({
    args: [`alb_${randomUUID()}`, raw.trim(), slug, mbid, now, now],
    sql: `insert into albums (id, name, slug, release_group_mbid, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict (slug) do nothing`,
  });

  const result = await db.execute({
    args: [slug],
    sql: `select id, release_group_mbid from albums where slug = ? limit 1`,
  });
  const row = typedRows<{ id: string; release_group_mbid: null | string }>(result.rows)[0];

  if (!row) {
    return undefined;
  }

  // Adopt the mbid onto a pre-existing slug row that has none — fill-empty-only. A rare
  // concurrent adoption of the same mbid onto two slugs loses the unique-index race harmlessly;
  // the id is already in hand, so a throw here must not lose it.
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

/**
 * The publish path's one call: mint the album entity for the album this track carries, and
 * stamp the track's `album_id` pointer at it. Best-effort and purely additive.
 */
export async function linkTrackToAlbum(
  trackId: string,
  raw: string | null | undefined,
): Promise<void> {
  const albumId = await ensureAlbum(raw);

  if (!albumId) {
    return;
  }

  const db = await getDb();

  await db.execute({
    args: [albumId, trackId],
    sql: `update tracks set album_id = ? where track_id = ?`,
  });
}

/** Resolve one album by its public slug (undefined = no such album). */
export async function getAlbumBySlug(slug: string): Promise<AlbumRecord | undefined> {
  const db = await getDb();
  // `datePublished` is the record's EARLIEST track release date, derived in the SAME read via a
  // correlated `min()` over the album's tracks (bounded to one album by the `album_id` index — not
  // a scan of a growing table). `release_group_mbid` + `upc` ride off the `albums` row itself.
  const result = await db.execute({
    args: [slug],
    sql: `select ${ALBUM_COLUMNS}, bio, release_group_mbid, upc,
                 (select min(t.release_date) from tracks t
                    where t.album_id = albums.id and t.release_date is not null) as release_date
          from albums where slug = ? limit 1`,
  });

  const row = typedRows<
    AlbumRow & {
      bio: string | null;
      release_date: string | null;
      release_group_mbid: string | null;
      upc: string | null;
    }
  >(result.rows)[0];

  return row
    ? {
        ...toAlbumRecord(row),
        bio: typeof row.bio === "string" && row.bio.trim() ? row.bio : undefined,
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

// ── The voiced bio: fill-empty-only write + the worklist (the entity-bio engine) ──────
//
// The album bio is the entity sibling of a finding's `note` and inherits its cardinal
// safety guarantee: the agent NEVER overwrites an existing bio. The `and (bio is null or
// trim(bio) = '')` predicate lives in the SQL, so an operator bio (or a second agent tick)
// that lands between the handler's read and this write can never be clobbered — the loser
// matches no row (mirrors `fillEmptyNote` / `fillEmptyArtistBio` / `fillEmptyLabelBio`).

/**
 * Fill an album's bio ATOMICALLY, only when it is currently empty. The bio + its PROVENANCE
 * (`bio_prompt_version`) + `bio_status = 'resolved'` land in the SAME statement, gated by the
 * fill-empty-only predicate. Returns whether a row was written (false = a non-empty bio was
 * already there / the album is gone). `promptVersion` is undefined for an operator-typed bio
 * and null when the sweep fell back to its baked prompt — both store NULL. The caller has
 * already voice-gated the bio (`gateBioText`).
 */
export async function fillEmptyAlbumBio(
  slug: string,
  bio: string,
  promptVersion?: number | null,
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [bio, promptVersion ?? null, new Date().toISOString(), slug],
    sql: `update albums
            set bio = ?, bio_prompt_version = ?, bio_status = 'resolved', updated_at = ?
          where slug = ?
            and (bio is null or trim(bio) = '')`,
  });

  return result.rowsAffected > 0;
}

/** One row of the bio worklist: an album with findings but no bio yet. */
export type AlbumBioWorkItem = { id: string; name: string; slug: string };

/**
 * The bio worklist: bio-empty albums whose page is INDEXABLE, oldest-first — the worklist the
 * `describe_album` cron drains. A bare read (no writes), bounded by `limit`. Two ways in, matching
 * exactly the two ways an `/album/<slug>` page renders:
 *
 * - a CERTIFIED album (at least one coordinate-bearing finding) — the original floor, preserved
 *   verbatim, so a certified-but-thin album never regresses out of the queue; OR
 * - a findings-free CATALOGUE album whose page clears the thin-content floor
 *   ({@link ALBUM_INDEX_MIN_TRACKS}) on renderable tracks alone — a crawl-minted page that is
 *   indexable earns a bio too, so it stops showing a bare tracklist with no dossier.
 *
 * The renderable count mirrors `listAlbumSitemapRows` exactly: over the `tracks.album_id` join, a
 * track counts when its finding is coordinate-bearing (`log_id is not null`) OR when there is no
 * finding row (the anti-join's `track_id is null` complement). Bounding the findings-free arm to the
 * indexable floor caps the Firecrawl + `claude -p` cost — a wide crawl mints thousands of stub
 * albums, and only the ones with a real page should ever enter the sweep.
 */
export async function listAlbumsMissingBio(limit: number): Promise<AlbumBioWorkItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [ALBUM_INDEX_MIN_TRACKS, limit],
    sql: `select a.id, a.name, a.slug
          from albums a
          where (a.bio is null or trim(a.bio) = '')
            and (
              exists (
                select 1 from tracks t
                join findings f on f.track_id = t.track_id
                where t.album_id = a.id and f.log_id is not null
              )
              or (
                select count(*)
                from tracks t2
                left join findings f2 on f2.track_id = t2.track_id
                where t2.album_id = a.id
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

/**
 * The album's own cover columns + the raw provider fallback, as `bestAlbumCoverUrl` wants them:
 * the OWNED ≤1200² master on Fluncle's R2 (served through the Cloudflare Images ladder) when the
 * cover-masters sweep has resolved one, else the freshest finding's captured album art. An album
 * OWNS these columns, so no packed subquery is needed — see cover-masters.ts + docs/album-artwork.md.
 */
const ALBUM_COVER_SELECT = `albums.image_key as image_key, albums.image_state as image_state,
           albums.image_updated_at as image_updated_at`;

/** The four cover columns as they come off an `albums`-rooted read. */
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

/**
 * Every ALBUM whose page clears the thin-content floor — findings or no findings. The exact twin
 * of `listLabelSitemapRows`, and that function carries the reasoning: the `/albums` hub is
 * Fluncle's editorial list (findings-joined), while the SITEMAP must carry every page that exists
 * and may be indexed, or an indexable page ends up orphaned from it. A crawl-minted, findings-free
 * album is a page on its tracklist exactly as a discovered label is on its releases, so it belongs
 * here once it clears the floor.
 *
 * The floor is applied in SQL (`having`), never in the isolate: a finding counts when it is
 * coordinate-bearing (`log_id is not null`), a catalogue row is the anti-join's complement, and
 * their sum is the RENDERABLE track count the page's `indexable` keys off — so the two agree by
 * construction.
 */
export async function listAlbumSitemapRows(minTracks: number): Promise<EntitySitemapRow[]> {
  const db = await getDb();
  const result = await db.execute({
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
          group by albums.id
          having sum(case when findings.log_id is not null then 1 else 0 end)
               + sum(case when findings.track_id is null then 1 else 0 end) >= ?
          order by albums.slug asc`,
  });

  return typedRows<AlbumCoverRow & { lastmod: string | null; slug: string }>(result.rows).map(
    (row) => ({
      coverImageUrl: albumCover(row),
      lastmod: row.lastmod ?? undefined,
      slug: row.slug,
    }),
  );
}

/** An album tile in the unified `/albums` index — lit (certified) or unlit, one row shape for both. */
export type AlbumHubEntry = {
  /** True ⇔ the album carries ≥1 coordinate-bearing finding — the certification light, visual only. */
  certified: boolean;
  /** A representative cover — its OWNED master when resolved, else any of its tracks' Spotify art. */
  coverImageUrl: string | undefined;
  name: string;
  slug: string;
  /** Renderable tracks on the album — findings plus the quieter rows, the tile's "N tracks". */
  trackCount: number;
};

/** The ALBUMS hub's `?page=N` read, over every floor-clearing record (certified + catalogue). */
const ALBUMS_HUB_QUERY: CatalogueHubQuery<AlbumHubEntry> = {
  entity: "albums",
  floor: ALBUM_INDEX_MIN_TRACKS,
  from: "albums join tracks on tracks.album_id = albums.id",
  groupBy: "albums.id",
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

/** The count of INDEXABLE `/album/<slug>` pages — the floor-clearing set `listAlbumSitemapRows`
    enumerates, for `/admin/funnel`'s public-surfaces card. Reuses `ALBUMS_HUB_QUERY` (scan + floor). */
export function countIndexableAlbums(): Promise<number> {
  return countIndexableHubEntities(ALBUMS_HUB_QUERY);
}

/**
 * One numbered page of the unified `/albums` index (the `?page=N` view) — every record Fluncle
 * holds, certified and catalogue alike, alphabetical. Albums have no A–Z lane (an album's identity
 * is its cover, and browse-by-title-initial is not how records are dug), so the numbered pager is
 * the album hub's crawl entry into the long tail.
 */
export function listAlbumsHubPage(
  page: number,
  nameFilter?: string,
): Promise<CatalogueHubNumberedPage<AlbumHubEntry>> {
  // Albums carry no A–Z lane at all, so the `withLetters` arm stays off either way; the name filter
  // just narrows the gated set.
  return listHubPage(ALBUMS_HUB_QUERY, page, false, nameFilter);
}

/** The ALBUMS full A–Z browse — every album with a page, certified or catalogue-only. */
// Derives its scan + floor from ALBUMS_HUB_QUERY (the web hub's), so the MCP browse and the
// /albums page can never diverge on which albums exist; only the projection differs (name inline).
const ALBUMS_BROWSE_QUERY: CatalogueBrowseQuery = {
  floor: ALBUMS_HUB_QUERY.floor,
  from: ALBUMS_HUB_QUERY.from,
  groupBy: ALBUMS_HUB_QUERY.groupBy,
  nameExpr: "albums.name",
  slugExpr: ALBUMS_HUB_QUERY.slugExpr,
};

export function listAlbumsBrowsePage(page: number): Promise<CatalogueBrowsePage> {
  return listCatalogueBrowsePage(ALBUMS_BROWSE_QUERY, page);
}

// ── THE PUBLIC CATALOGUE LIST/GET API OPS (list_albums / get_album) ───────────────────────
//
// The album twin of the label API ops in labels.ts (read that section): the list is the SAME
// unified `/albums` index the web page serves — built on the shared `listHubPage` off
// `ALBUMS_HUB_QUERY`, so it can never disagree with the web hub or the MCP browse on which albums
// exist — plus the one `findingCount` column the tile doesn't project. `get_album` resolves ANY
// album that has a page (below-floor albums render on `/album/<slug>` too, just noindex).

/** The owned-master columns + fallback subquery for one album's cover, by id. */
const ALBUM_COVER_JSON = `${ALBUM_COVER_SELECT},
           (select t2.album_image_url from tracks t2
              where t2.album_id = albums.id and t2.album_image_url is not null
              order by t2.release_date is null asc, t2.release_date desc, t2.track_id asc
              limit 1) as cover_url`;

/**
 * One alphabetical page of the unified `/albums` index over the API — the `list_albums` read. The
 * SAME floor-clearing set the `/albums` web page and the MCP browse serve (all three off
 * `HUB_INCLUSION_HAVING`). Reuses the hub reader for the page + covers + pager, stamping each row's
 * `findingCount` from the shared fragments.
 */
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

/** One album's cover, by id — the single-album read behind `get_album`. */
async function albumCoverUrl(albumId: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [albumId],
    sql: `select ${ALBUM_COVER_JSON} from albums where albums.id = ? limit 1`,
  });
  const row = typedRows<AlbumCoverRow>(result.rows)[0];

  return row ? albumCover(row) : undefined;
}

/**
 * One album's full public read — the `get_album` op's shape. Resolves ANY album that has a page (a
 * below-floor album the browse index omits still renders on `/album/<slug>`, just noindex). Counts
 * come from `hubCountsBySlug` (the same aggregates the hub gate uses), so a certified album's list
 * row and get read agree. Undefined when no album carries the slug (the handler 404s).
 */
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

// THE ALBUM EDGE IS WRITTEN INLINE, not deferred. The publish path calls `linkTrackToAlbum`
// on a certified add, and the catalogue crawler ensures + links the album at crawl time,
// folded on the release-group MBID (`ensureAlbum(name, releaseGroupMbid)`, crawl.ts). There is
// no recurring deploy backfill for albums — the row is minted and the pointer stamped off the
// bat. The ONE-OFF `scripts/backfill-album-graph.ts` (operator-run, NOT in the deploy chain)
// populates `release_group_mbid` on existing rows and stamps `album_id` on catalogue tracks
// that pre-date this path; it is history's catch-up, not a steady-state step.
