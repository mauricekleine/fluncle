import { randomUUID } from "node:crypto";
import { type ArtistSocialPlatform, ARTIST_SOCIAL_PLATFORMS } from "../artist-socials";
import { getDb, typedRow, typedRows } from "./db";
import { fetchArtistImages } from "./spotify";
import { fold } from "./track-match";

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
  id: string;
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

/** A row in the `/artists` index + a thin-gated sitemap candidate. */
export type ArtistIndexEntry = {
  coverImageUrl: string | undefined;
  findingCount: number;
  /** The artist's canonical Spotify avatar (null → the index renders a monogram tile). */
  imageUrl: string | undefined;
  lastmod: string | undefined;
  name: string;
  slug: string;
};

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Resolve one artist by its public slug (null = no such artist). */
export async function getArtistBySlug(slug: string): Promise<ArtistRecord | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select id, name, slug, spotify_url, mbid, wikidata_qid
          from artists where slug = ? limit 1`,
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;

  if (!row || typeof row["id"] !== "string" || typeof row["name"] !== "string") {
    return undefined;
  }

  return {
    id: row["id"],
    mbid: optionalText(row["mbid"]),
    name: row["name"],
    slug: typeof row["slug"] === "string" ? row["slug"] : slug,
    spotifyUrl: optionalText(row["spotify_url"]),
    wikidataQid: optionalText(row["wikidata_qid"]),
  };
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
 * `track_artists` inner join (NO `artists_json` fallback), the SAME count the
 * `/artists` index and the sitemap key off (`listArtistsWithFindingCounts`). The
 * artist page's `noindex` gate keys off THIS (not the fallback-inclusive grid
 * count) so an indexable page is never orphaned from the sitemap + index during
 * the backfill window (Unit 3, artist-relationship RFC §3).
 */
export async function countArtistFindings(artistId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [artistId],
    sql: `select count(*) as finding_count
          from tracks
          join track_artists on track_artists.track_id = tracks.track_id
          where track_artists.artist_id = ? and tracks.log_id is not null`,
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  const count = row?.["finding_count"];

  return typeof count === "number" ? count : 0;
}

/**
 * Every artist that has at least one coordinate-bearing finding, with its finding
 * count, a representative cover (the most-recent finding's album art), and the
 * freshest finding date (sitemap lastmod). Ordered by finding count desc, then
 * name — the `/artists` index order; the sitemap filters this to
 * `ARTIST_INDEX_MIN_FINDINGS`+ (the thin-content gate).
 */
export async function listArtistsWithFindingCounts(): Promise<ArtistIndexEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select a.name as name, a.slug as slug, a.image_url as image_url,
                 count(t.track_id) as finding_count,
                 max(t.added_at) as lastmod,
                 (select t2.album_image_url
                    from tracks t2
                    join track_artists ta2 on ta2.track_id = t2.track_id
                    where ta2.artist_id = a.id and t2.log_id is not null
                    order by t2.added_at desc limit 1) as cover_url
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join tracks t on t.track_id = ta.track_id and t.log_id is not null
          group by a.id
          order by finding_count desc, a.name asc`,
  });

  const entries: ArtistIndexEntry[] = [];

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const name = row["name"];
    const slug = row["slug"];
    const findingCount = row["finding_count"];

    if (typeof name === "string" && typeof slug === "string" && typeof findingCount === "number") {
      entries.push({
        coverImageUrl: optionalText(row["cover_url"]),
        findingCount,
        imageUrl: optionalText(row["image_url"]),
        lastmod: optionalText(row["lastmod"]),
        name,
        slug,
      });
    }
  }

  return entries;
}

/** A public artist list item — the `list_artists` / `get_artist` API shape. */
export type ArtistListItem = {
  findingCount: number;
  name: string;
  slug: string;
  spotifyUrl: string | undefined;
};

type ArtistRow = {
  finding_count: number;
  name: string;
  slug: string;
  spotify_url: string | null;
};

function toArtistListItem(row: ArtistRow): ArtistListItem {
  return {
    findingCount: row.finding_count,
    name: row.name,
    slug: row.slug,
    spotifyUrl: row.spotify_url ?? undefined,
  };
}

/**
 * All artists with at least one PUBLISHED finding, ordered by finding count
 * descending. `finding_count` counts only published findings (a `track_artists`
 * row whose track has `log_id IS NOT NULL`); the inner join also drops any artist
 * with zero published findings. Used by `list_artists`.
 */
export async function listArtists(): Promise<ArtistListItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select
            a.name,
            a.slug,
            a.spotify_url,
            count(ta.track_id) as finding_count
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join tracks t on t.track_id = ta.track_id and t.log_id is not null
          group by a.id
          order by finding_count desc, a.name asc`,
  });

  return typedRows<ArtistRow>(result.rows).map(toArtistListItem);
}

/**
 * Look up one artist by slug for the public API, with the SAME published gate as
 * `listArtists`: an artist with zero published findings resolves to `undefined`
 * (the caller turns that into a 404), so list + get agree on which artists exist.
 * Distinct from `getArtistBySlug`, which returns the richer `ArtistRecord` the
 * artist PAGE + JSON-LD read. Used by `get_artist`.
 */
export async function getArtistListItemBySlug(slug: string): Promise<ArtistListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [slug],
    sql: `select
            a.name,
            a.slug,
            a.spotify_url,
            count(ta.track_id) as finding_count
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join tracks t on t.track_id = ta.track_id and t.log_id is not null
          where a.slug = ?
          group by a.id
          limit 1`,
  });

  const row = typedRow<ArtistRow>(result.rows);
  return row ? toArtistListItem(row) : undefined;
}

export function parseArtistsJson(value: string): string[] {
  try {
    const artists = JSON.parse(value) as unknown;

    if (Array.isArray(artists)) {
      return artists.filter((artist): artist is string => typeof artist === "string");
    }
  } catch (error) {
    console.warn("parseArtistsJson: malformed artists_json column", error);
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

// Upsert artists + track_artists for a track that was just inserted. Called at
// ingest (publish path) and by the backfill. Idempotent: existing artist rows
// are matched by `spotify_artist_id` and their `name` + `updated_at` are updated
// if the name changed; `track_artists` rows are matched by the composite PK
// (track_id, artist_id). Silently no-ops when `spotifyArtistIds` is empty (a
// track with no parseable artist data, or a dry-run caller).
export async function upsertTrackArtists(
  trackId: string,
  artistNames: string[],
  spotifyArtistIds: string[],
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
  // block the fast synchronous add — the image backfill sweeps up anything missed.
  try {
    await fillMissingArtistImages(spotifyArtistIds);
  } catch (error) {
    console.warn("upsertTrackArtists: artist image fill failed (non-fatal)", error);
  }
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
  /** ISO stamp of when this link was discovered/added — the "is this newer than the last
   *  review?" anchor behind an artist's needs-a-look flag. */
  createdAt: string;
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

  return {
    artistId: textOf(row["artist_id"]),
    createdAt: textOf(row["created_at"]),
    id: textOf(row["id"]),
    platform: isArtistSocialPlatform(platform) ? platform : "homepage",
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
 */
export async function listArtistSocialsQueue(limit = 100): Promise<ArtistSocialsQueueItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.max(1, Math.min(limit, 500))],
    sql: `select a.id as artist_id, a.name, a.slug, a.spotify_url,
                 s.id, s.platform, s.url, s.source, s.status, s.created_at
          from artists a
          join artist_socials s on s.artist_id = a.id
          where a.id in (
            select artist_id from artist_socials
            where status = 'candidate'
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
  /** When the operator last acknowledged this artist's link list ("Looks good"), or null.
   *  The UI flags "needs a look" when a social's `createdAt` is newer than this. */
  reviewedAt: string | null;
};

/** Whether an artist has a link the operator hasn't seen since their last review — the single
 *  needs-a-look predicate, shared by the overview UI and the /admin attention count. A link is
 *  "unseen" when it was discovered/added after `reviewedAt` (or the list was never reviewed). */
export function artistNeedsLook(
  reviewedAt: string | null,
  socials: readonly { createdAt: string }[],
): boolean {
  const seenThrough = reviewedAt ?? "";

  return socials.some((social) => social.createdAt > seenThrough);
}

// The `/admin/artists` overview — EVERY artist Fluncle features, name-sorted, each with its
// full socials list (confirmed, auto, and candidate) and its finding count. Unlike the review
// QUEUE above (which narrows to the not-yet-confirmed backlog that feeds the /admin attention
// row), this is the stable MANAGEMENT surface: an artist never drops off it for being resolved,
// so the operator can edit, add, or remove a link any time — when a profile moves, is deleted,
// or a missing one turns up. A socialless artist still lists (LEFT JOIN) so a link can be added.
export async function listAllArtistsWithSocials(): Promise<ArtistOverviewItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select a.id as artist_id, a.name, a.slug, a.spotify_url, a.reviewed_at,
                 (select count(*) from tracks t
                    join track_artists ta on ta.track_id = t.track_id
                    where ta.artist_id = a.id and t.log_id is not null) as finding_count,
                 s.id, s.platform, s.url, s.source, s.status, s.created_at
          from artists a
          left join artist_socials s on s.artist_id = a.id
          order by a.name asc, s.platform asc`,
  });

  const byArtist = new Map<string, ArtistOverviewItem>();

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const artistId = textOf(row["artist_id"]);
    let artist = byArtist.get(artistId);

    if (!artist) {
      const spotifyUrl = row["spotify_url"];
      const findingCount = row["finding_count"];
      const reviewedAt = row["reviewed_at"];
      artist = {
        findingCount: Number(findingCount) || 0,
        id: artistId,
        name: textOf(row["name"]),
        reviewedAt: typeof reviewedAt === "string" ? reviewedAt : null,
        slug: textOf(row["slug"]),
        socials: [],
        spotifyUrl: typeof spotifyUrl === "string" ? spotifyUrl : null,
      };
      byArtist.set(artistId, artist);
    }

    // LEFT JOIN: an artist with no socials yields one row with null social columns — skip it.
    if (row["id"] !== null && row["id"] !== undefined) {
      artist.socials.push(toArtistSocial({ ...row, artist_id: artistId }));
    }
  }

  return [...byArtist.values()];
}

export type ArtistReviewRow = {
  artistId: string;
  name: string;
  /** The oldest unseen link's created stamp — the queue's oldest-first anchor. */
  anchorAt: string;
  /** How many links are new since the operator last reviewed this artist. */
  pending: number;
};

// The /admin attention row's honest read: one row per artist with a link discovered SINCE the
// operator last acknowledged the list ("Looks good") — or never acknowledged — with the count of
// unseen links and the oldest one's stamp (the queue's oldest-first anchor). Mirrors
// artistNeedsLook; the pure model turns each into a "Review →" deep-link onto /admin/artists (the
// manage surface), so the queue surfaces the work and the page does it. This is a per-artist ACK,
// not per-link follow bookkeeping — a link Fluncle can't act on (no Facebook profile) no longer
// nags forever.
export async function listArtistReviewRows(): Promise<ArtistReviewRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select a.id as artist_id, a.name,
                 count(*) as pending, min(s.created_at) as anchor_at
          from artists a
          join artist_socials s on s.artist_id = a.id
          where s.created_at > coalesce(a.reviewed_at, '')
          group by a.id, a.name
          order by anchor_at asc`,
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
    sql: `select id, artist_id, platform, url, source, status, created_at
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
 * `status=confirmed` (it renders publicly at once). Upserts on the `(artist_id, platform)`
 * unique index. Adding a link also stamps the artist as reviewed (the operator was looking at
 * the whole list to add one, so it needn't immediately flip back to "needs a look"). Returns
 * the fresh row.
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
    args: [randomUUID(), artistId, platform, trimmed, now, now],
    sql: `insert into artist_socials
            (id, artist_id, platform, url, source, status, created_at, updated_at)
          values (?, ?, ?, ?, 'operator', 'confirmed', ?, ?)
          on conflict(artist_id, platform) do update set
            url = excluded.url,
            source = 'operator',
            status = 'confirmed',
            updated_at = excluded.updated_at`,
  });

  // Adding implies the operator saw the list — stamp reviewed so the new link (created_at = now)
  // doesn't itself re-arm needs-a-look (`created_at > reviewed_at` is false when they're equal).
  await db.execute({
    args: [now, now, artistId],
    sql: `update artists set reviewed_at = ?, updated_at = ? where id = ?`,
  });

  const result = await db.execute({
    args: [artistId, platform],
    sql: `select id, artist_id, platform, url, source, status, created_at
          from artist_socials where artist_id = ? and platform = ? limit 1`,
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    throw new InvalidArtistSocialError("Failed to persist the social");
  }

  return toArtistSocial(row);
}

/**
 * Mark an artist's link list as reviewed — the operator's "Looks good". Stamps `reviewed_at =
 * now` so every link discovered up to now counts as seen (needs-a-look clears until a NEW link
 * arrives), AND promotes any surviving `candidate` links to `confirmed`: reviewing the list IS
 * the trust gate (a wrong candidate is deleted in Manage links before this), so what's left is
 * good to go public. Idempotent. Returns the count of candidates promoted.
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
    sql: `update artists set reviewed_at = ?, updated_at = ? where id = ?`,
  });

  return { confirmed: promoted.rowsAffected ?? 0 };
}

/** Remove one artist social by id (the operator's inline delete). Idempotent. */
export async function removeArtistSocial(socialId: string): Promise<void> {
  const db = await getDb();

  await db.execute({ args: [socialId], sql: `delete from artist_socials where id = ?` });
}
