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
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { getDb, typedRows } from "./db";
import { type EntitySitemapRow } from "./labels";

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
  const result = await db.execute({
    args: [slug],
    sql: `select ${ALBUM_COLUMNS}, bio from albums where slug = ? limit 1`,
  });

  const row = typedRows<AlbumRow & { bio: string | null }>(result.rows)[0];

  return row
    ? {
        ...toAlbumRecord(row),
        bio: typeof row.bio === "string" && row.bio.trim() ? row.bio : undefined,
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
 * The bio worklist: albums that have at least one coordinate-bearing finding but NO bio
 * yet, oldest-first — the worklist the `describe_album` cron drains. A bare read (no writes),
 * bounded by `limit`. An album earns a bio only once Fluncle has logged a track off it, so
 * the `exists` gate is the same certified-finding floor the album page uses.
 */
export async function listAlbumsMissingBio(limit: number): Promise<AlbumBioWorkItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [limit],
    sql: `select a.id, a.name, a.slug
          from albums a
          where (a.bio is null or trim(a.bio) = '')
            and exists (
              select 1 from tracks t
              join findings f on f.track_id = t.track_id
              where t.album_id = a.id and f.log_id is not null
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

// TEMPORARY — slice 004 (catalogue publicness) removes this gate. Grep `albumHasCertifiedFindingSql`.
//
// Slice 001 mints an album row + the `album_id` edge for a crawled record at crawl time — the
// internal GRAPH is fully populated (row + release-group fold + adopt). Public REACHABILITY is a
// separate, reviewed slice (004): until it deliberately flips, a crawl-minted album with NO
// certified finding must stay invisible on every public surface — its `/album/<slug>` 404s, it is
// out of the sitemap, and a catalogue heading does not link to it — exactly as in the
// pre-inline-mint world where the row simply did not exist. This predicate IS the whole gate: an
// album is publicly reachable only if some track on it is a certified finding (`log_id` present).
// A certified-finding album is unchanged throughout. Slice 004 deletes this helper + every caller.
export function albumHasCertifiedFindingSql(albumIdExpr: string): string {
  return `exists (select 1 from findings cf join tracks ct on ct.track_id = cf.track_id
                  where ct.album_id = ${albumIdExpr} and cf.log_id is not null)`;
}

/**
 * Every ALBUM whose page clears the thin-content floor. The exact twin of `listLabelSitemapRows`,
 * and that function carries the reasoning: the `/albums` hub is Fluncle's editorial list
 * (findings-joined), while the SITEMAP must carry every page that exists and may be indexed, or an
 * indexable page ends up orphaned from it.
 *
 * The floor is applied in SQL (`having`), never in the isolate. TEMPORARY (slice 004): the
 * `albumHasCertifiedFindingSql` gate keeps a crawl-minted, findings-free album OUT of the sitemap
 * until the publicness slice — findings-bounded for now, so a page that 404s is never advertised.
 */
export async function listAlbumSitemapRows(minTracks: number): Promise<EntitySitemapRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [minTracks],
    sql: `select albums.slug as slug,
                 max(findings.added_at) as lastmod,
                 (select t2.album_image_url
                    from findings f2 join tracks t2 on t2.track_id = f2.track_id
                    where t2.album_id = albums.id and f2.log_id is not null
                    order by f2.added_at desc limit 1) as cover_url
          from albums
          join tracks on tracks.album_id = albums.id
          left join findings on findings.track_id = tracks.track_id
          where ${albumHasCertifiedFindingSql("albums.id")}
          group by albums.id
          having sum(case when findings.log_id is not null then 1 else 0 end)
               + sum(case when findings.track_id is null then 1 else 0 end) >= ?
          order by albums.slug asc`,
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

// THE ALBUM EDGE IS WRITTEN INLINE, not deferred. The publish path calls `linkTrackToAlbum`
// on a certified add, and the catalogue crawler ensures + links the album at crawl time,
// folded on the release-group MBID (`ensureAlbum(name, releaseGroupMbid)`, crawl.ts). There is
// no recurring deploy backfill for albums — the row is minted and the pointer stamped off the
// bat. The ONE-OFF `scripts/backfill-album-graph.ts` (operator-run, NOT in the deploy chain)
// populates `release_group_mbid` on existing rows and stamps `album_id` on catalogue tracks
// that pre-date this path; it is history's catch-up, not a steady-state step.
