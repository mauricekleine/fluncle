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
// A row is minted ONLY off a certified finding: an album earns an entity, a page, and a
// sitemap slot because Fluncle FOUND something on it. See docs/album-entity.md.

import { randomUUID } from "node:crypto";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { getDb, typedRows } from "./db";

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
  id: string;
  name: string;
  slug: string;
};

/** A row in the `/albums` index + a thin-gated sitemap candidate. */
export type AlbumIndexEntry = {
  /**
   * Uncertified tracks linked to this album — the quieter rows the page will render. It is
   * NOT shown in the index (the tier has no public name and is never counted aloud); it
   * exists so the SITEMAP can apply the same renderable-track gate the PAGE applies, and an
   * indexable page is therefore never orphaned from the sitemap. Zero until the catalogue
   * lands.
   */
  catalogueCount: number;
  /** The album's cover — its freshest finding's Spotify album art. */
  coverImageUrl: string | undefined;
  findingCount: number;
  /** ISO of the album's freshest finding — the sitemap `lastmod`. */
  lastmod: string | undefined;
  name: string;
  slug: string;
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
 * Idempotent and NON-CLOBBERING: an existing row keeps its display `name` (the first
 * spelling seen wins). A blank album name mints nothing and returns `undefined`. Called
 * best-effort from the publish path, so a failure here must never block an add — the
 * deploy-time reconcile backstops it.
 */
export async function ensureAlbum(raw: string | null | undefined): Promise<string | undefined> {
  const slug = albumSlug(raw);

  if (!slug || typeof raw !== "string") {
    return undefined;
  }

  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [`alb_${randomUUID()}`, raw.trim(), slug, now, now],
    sql: `insert into albums (id, name, slug, created_at, updated_at)
          values (?, ?, ?, ?, ?)
          on conflict (slug) do nothing`,
  });

  const result = await db.execute({
    args: [slug],
    sql: `select id from albums where slug = ? limit 1`,
  });

  return typedRows<{ id: string }>(result.rows)[0]?.id;
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
  const result = await db.execute({
    args: [slug],
    sql: `select ${ALBUM_COLUMNS} from albums where slug = ? limit 1`,
  });

  const row = typedRows<AlbumRow>(result.rows)[0];

  return row ? toAlbumRecord(row) : undefined;
}

/**
 * Every album with at least one coordinate-bearing finding, with its finding count, its
 * cover (the freshest finding's album art), and that finding's date (the sitemap
 * `lastmod`). Alphabetical by name — the `/albums` index order.
 *
 * BOUNDED BY THE ARCHIVE, NOT THE CATALOGUE: it drives from the findings join, so an
 * album Fluncle has never certified anything on is never listed, however many catalogue
 * tracks hang off it. The sitemap filters this list further by the thin-content gate.
 */
export async function listAlbumsWithFindingCounts(): Promise<AlbumIndexEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select albums.name as name, albums.slug as slug,
                 count(*) as finding_count,
                 (select count(*) from tracks t3
                    left join findings f3 on f3.track_id = t3.track_id
                    where t3.album_id = albums.id and f3.track_id is null) as catalogue_count,
                 max(findings.added_at) as lastmod,
                 (select t2.album_image_url
                    from findings f2 join tracks t2 on t2.track_id = f2.track_id
                    where t2.album_id = albums.id and f2.log_id is not null
                    order by f2.added_at desc limit 1) as cover_url
          from albums
          join tracks on tracks.album_id = albums.id
          join findings on findings.track_id = tracks.track_id
          where findings.log_id is not null
          group by albums.id
          order by albums.name collate nocase asc`,
  });

  return typedRows<{
    catalogue_count: number;
    cover_url: string | null;
    finding_count: number;
    lastmod: string | null;
    name: string;
    slug: string;
  }>(result.rows).map((row) => ({
    catalogueCount: Number(row.catalogue_count),
    coverImageUrl: row.cover_url ?? undefined,
    findingCount: Number(row.finding_count),
    lastmod: row.lastmod ?? undefined,
    name: row.name,
    slug: row.slug,
  }));
}

// The deterministic reconcile — an `albums` row for every album a certified finding
// carries, plus the `tracks.album_id` pointer for every track whose album has one — lives
// in `scripts/backfill-albums.ts` (the `backfill-labels.ts` precedent: a standalone,
// Client-taking script wired into `db:backfill`, so the DDL and the data it populates ship
// atomically on every deploy). That is the self-healing backstop behind `linkTrackToAlbum`,
// and the path by which a track written by ANY other writer — an admin update, a future
// catalogue crawler that knows nothing of this column — is linked into the graph.
