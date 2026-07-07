import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { followSpotifyArtist } from "./spotify";
import { resolveYouTubeChannelId, subscribeToYouTubeChannel } from "./youtube";

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
}

// ── The identity graph: artist_socials ───────────────────────────────────────
// The championing motion (Epic B of the artist-relationship RFC) reads + writes the
// per-artist social rows here: the `/admin/artists` follow queue (list + operator
// register/confirm + inline add/remove), the board's automated-socials aggregate,
// and the agent-tier auto-follow sweep (Spotify + YouTube).

/** The socials the identity graph stores (the KG anchors mbid/wikidata are `artists` columns). */
export type ArtistSocialPlatform =
  | "spotify"
  | "youtube"
  | "mixcloud"
  | "soundcloud"
  | "instagram"
  | "tiktok"
  | "bandcamp"
  | "twitter"
  | "facebook"
  | "homepage";

/** The canonical platform order (the queue + the add-platform Select render in this order). */
export const ARTIST_SOCIAL_PLATFORMS: ArtistSocialPlatform[] = [
  "spotify",
  "youtube",
  "soundcloud",
  "instagram",
  "tiktok",
  "mixcloud",
  "bandcamp",
  "twitter",
  "facebook",
  "homepage",
];

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
  /** ISO stamp of when Fluncle followed/registered this platform, or null. */
  followedAt: string | null;
};

/** One artist in the follow queue, carrying all of its socials for the operator's glance. */
export type ArtistFollowQueueItem = {
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
  const followedAt = row["followed_at"];

  return {
    artistId: textOf(row["artist_id"]),
    followedAt: typeof followedAt === "string" ? followedAt : null,
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
 * The `/admin/artists` follow queue: every artist that still has actionable work —
 * a `candidate` social to confirm, or a followable (`spotify`/`youtube`) `auto`/
 * `confirmed` social not yet followed. Each artist carries ALL its socials so the
 * operator sees the whole identity graph in one card. Bounded so a huge archive
 * never blows the payload; the queue is small by construction (most socials arrive
 * `auto` from MusicBrainz — the RFC's design note).
 */
export async function listArtistSocialsQueue(limit = 100): Promise<ArtistFollowQueueItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.max(1, Math.min(limit, 500))],
    sql: `select a.id as artist_id, a.name, a.slug, a.spotify_url,
                 s.id, s.platform, s.url, s.source, s.status, s.followed_at
          from artists a
          join artist_socials s on s.artist_id = a.id
          where a.id in (
            select artist_id from artist_socials
            where status = 'candidate'
               or (platform in ('spotify', 'youtube')
                   and status in ('auto', 'confirmed')
                   and followed_at is null)
            limit ?
          )
          order by a.name asc, s.platform asc`,
  });

  const byArtist = new Map<string, ArtistFollowQueueItem>();

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

/** The board's automated-socials aggregate: the Spotify/YouTube follow targets per platform. */
export type ArtistFollowTarget = {
  platform: "spotify" | "youtube";
  status: "auto" | "confirmed";
  url: string;
  /** True only when EVERY target of this platform (across a collab's artists) is followed. */
  followed: boolean;
};

/**
 * Per finding, the follow state of its artist(s)' Spotify/YouTube socials — the board's
 * automated-socials cell reads this (folded together with the Last.fm love). Only
 * `auto`/`confirmed` socials count (a `candidate` isn't a follow target yet). Aggregated
 * per platform across a collab's artists: `followed` is true only when every such target
 * is followed. Returns an empty map for no ids (no query).
 */
export async function listArtistFollowsForTracks(
  trackIds: string[],
): Promise<Map<string, ArtistFollowTarget[]>> {
  const out = new Map<string, ArtistFollowTarget[]>();

  if (trackIds.length === 0) {
    return out;
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select ta.track_id, s.platform, s.status, s.url, s.followed_at
          from track_artists ta
          join artist_socials s on s.artist_id = ta.artist_id
          where ta.track_id in (${placeholders})
            and s.platform in ('spotify', 'youtube')
            and s.status in ('auto', 'confirmed')`,
  });

  // Accumulate per (track, platform): the first url/status seen + whether ALL rows are followed.
  const acc = new Map<
    string,
    Map<string, { status: "auto" | "confirmed"; url: string; followed: boolean }>
  >();

  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    const trackId = textOf(row["track_id"]);
    const platform = textOf(row["platform"]);

    if (platform !== "spotify" && platform !== "youtube") {
      continue;
    }

    const status = row["status"] === "confirmed" ? "confirmed" : "auto";
    const followed = typeof row["followed_at"] === "string";
    let platforms = acc.get(trackId);

    if (!platforms) {
      platforms = new Map();
      acc.set(trackId, platforms);
    }

    const existing = platforms.get(platform);

    if (existing) {
      existing.followed = existing.followed && followed;
    } else {
      platforms.set(platform, { followed, status, url: textOf(row["url"]) });
    }
  }

  for (const [trackId, platforms] of acc) {
    const targets: ArtistFollowTarget[] = [];

    for (const [platform, value] of platforms) {
      targets.push({
        followed: value.followed,
        platform: platform as "spotify" | "youtube",
        status: value.status,
        url: value.url,
      });
    }

    out.set(trackId, targets);
  }

  return out;
}

// Fetch one social row by id, or undefined. Small helper for the operator writes,
// which return the fresh row for the board's optimistic patch.
async function getArtistSocialById(socialId: string): Promise<ArtistSocial | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [socialId],
    sql: `select id, artist_id, platform, url, source, status, followed_at
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
 * Register that the operator manually followed (or otherwise actioned) a social —
 * stamps `followed_at`. Idempotent: an already-followed row keeps its original stamp.
 * Returns the fresh row for the board's optimistic patch.
 */
export async function recordOperatorFollow(socialId: string): Promise<ArtistSocial> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [now, now, socialId],
    sql: `update artist_socials set followed_at = ?, updated_at = ?
          where id = ? and followed_at is null`,
  });

  const social = await getArtistSocialById(socialId);

  if (!social) {
    throw new ArtistSocialNotFoundError(socialId);
  }

  return social;
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

/** Non-throwing sibling of `assertHttpUrl` — the defensive render guard (emit `href` only when true). */
export function isHttpUrl(raw: string): boolean {
  try {
    assertHttpUrl(raw);

    return true;
  } catch {
    return false;
  }
}

/**
 * Add (or replace) an artist's social by platform — the operator's inline add in the
 * queue. An operator-entered link is trusted, so it lands `source=operator`,
 * `status=confirmed` (it renders publicly at once). Upserts on the `(artist_id,
 * platform)` unique index. Returns the fresh row.
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

  const result = await db.execute({
    args: [artistId, platform],
    sql: `select id, artist_id, platform, url, source, status, followed_at
          from artist_socials where artist_id = ? and platform = ? limit 1`,
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    throw new InvalidArtistSocialError("Failed to persist the social");
  }

  return toArtistSocial(row);
}

/** Remove one artist social by id (the operator's inline delete). Idempotent. */
export async function removeArtistSocial(socialId: string): Promise<void> {
  const db = await getDb();

  await db.execute({ args: [socialId], sql: `delete from artist_socials where id = ?` });
}

// ── The auto-follow sweep (agent tier) ───────────────────────────────────────

// THE QUOTA CEILING. A YouTube `subscriptions.insert` costs 50 units against the Data API's
// default 200 units/day → only ~4 real subscribes/day. The on-box `fluncle-artist-follow`
// cron paces the trigger (BATCH_CAP=20, every 6h) and the CLI default `--limit` is low, but
// cadence alone is fragile: a mis-set schedule or a manual `fluncle admin artists follow
// --limit 50` could blow the quota. This server-side per-day cap is the real backstop — it
// counts today's YouTube follows and stops calling the API past the ceiling regardless of how
// the sweep was triggered. Spotify's follow endpoint is cheap, so only YouTube is capped.
const YOUTUBE_DAILY_FOLLOW_CAP = 4;

// The start of the current UTC day as an ISO stamp — the lower bound for "followed today".
// `followed_at` is stored as an ISO-8601 string, so a lexicographic `>=` compares correctly.
function startOfUtcDayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);

  return d.toISOString();
}

/** One target the auto-follow sweep acted on (or would, in a dry run). */
export type FollowResult = {
  socialId: string;
  artistId: string;
  artistName: string;
  platform: "spotify" | "youtube";
};

/** One target the sweep tried and couldn't follow (a bad url, a missing channel, an API error). */
export type FollowFailure = {
  socialId: string;
  platform: "spotify" | "youtube";
  error: string;
};

export type FollowBatchSummary = {
  dryRun: boolean;
  followed: FollowResult[];
  followedCount: number;
  failed: FollowFailure[];
  failedCount: number;
  /** Pending followable targets still unfollowed after this batch (so the sweep can loop). */
  remaining: number;
};

// Parse a Spotify artist id out of an `open.spotify.com/artist/<id>` URL.
function spotifyArtistIdFromUrl(url: string): string | undefined {
  return url.match(/artist\/([A-Za-z0-9]{22})/)?.[1];
}

/**
 * Follow a bounded batch of high-confidence artists across Spotify + YouTube — the
 * championing motion's automated half (`follow_artist`, agent tier). Acts only on
 * followable (`spotify`/`youtube`) socials that are `auto`/`confirmed` and not yet
 * followed (idempotent by `followed_at IS NULL`), oldest first, capped at `limit` so a
 * tick stays inside the platforms' quotas. On success it stamps `followed_at`; a per-
 * target failure never aborts the batch. `dryRun` reports what WOULD be followed
 * without calling the APIs or writing. `remaining` lets the on-box sweep loop until 0.
 */
export async function followPendingArtists(limit = 5, dryRun = false): Promise<FollowBatchSummary> {
  const db = await getDb();
  const cap = Math.max(1, Math.min(limit, 50));

  const pending = await db.execute({
    args: [cap],
    sql: `select s.id as social_id, s.platform, s.url, a.id as artist_id, a.name,
                 a.spotify_artist_id
          from artist_socials s
          join artists a on a.id = s.artist_id
          where s.platform in ('spotify', 'youtube')
            and s.status in ('auto', 'confirmed')
            and s.followed_at is null
          order by s.created_at asc
          limit ?`,
  });

  const followed: FollowResult[] = [];
  const failed: FollowFailure[] = [];

  // How many YouTube subscribes already happened today — the running total the per-day cap
  // guards. Only queried for a real run (a dry run calls no APIs, so the ceiling can't apply).
  let youtubeFollowedToday = 0;

  if (!dryRun) {
    const dayCount = await db.execute({
      args: [startOfUtcDayIso()],
      sql: `select count(*) as n from artist_socials
            where platform = 'youtube' and followed_at >= ?`,
    });
    const dayRow = dayCount.rows[0] as Record<string, unknown> | undefined;
    const n = Number(dayRow?.["n"] ?? 0);
    youtubeFollowedToday = Number.isFinite(n) ? n : 0;
  }

  for (const raw of pending.rows) {
    const row = raw as Record<string, unknown>;
    const platform = row["platform"] === "youtube" ? "youtube" : "spotify";
    const socialId = textOf(row["social_id"]);
    const artistId = textOf(row["artist_id"]);
    const artistName = textOf(row["name"]);
    const url = textOf(row["url"]);
    const spotifyArtistId =
      typeof row["spotify_artist_id"] === "string" ? row["spotify_artist_id"] : undefined;

    try {
      if (dryRun) {
        followed.push({ artistId, artistName, platform, socialId });
        continue;
      }

      if (platform === "spotify") {
        const id = spotifyArtistId ?? spotifyArtistIdFromUrl(url);

        if (!id) {
          throw new Error("no resolvable Spotify artist id");
        }

        await followSpotifyArtist(id);
      } else {
        // Stop before spending quota past the daily ceiling — recorded as a failure (the
        // target stays unfollowed for the next day's sweep), never a silent skip.
        if (youtubeFollowedToday >= YOUTUBE_DAILY_FOLLOW_CAP) {
          throw new Error(
            `daily YouTube follow cap reached (${YOUTUBE_DAILY_FOLLOW_CAP}/day) — deferred`,
          );
        }

        const channelId = await resolveYouTubeChannelId(url);

        if (!channelId) {
          throw new Error("no resolvable YouTube channel id");
        }

        await subscribeToYouTubeChannel(channelId);
        youtubeFollowedToday += 1;
      }

      const now = new Date().toISOString();
      await db.execute({
        args: [now, now, socialId],
        sql: `update artist_socials set followed_at = ?, updated_at = ? where id = ?`,
      });

      followed.push({ artistId, artistName, platform, socialId });
    } catch (error) {
      failed.push({
        error: error instanceof Error ? error.message : String(error),
        platform,
        socialId,
      });
    }
  }

  const remainingResult = await db.execute({
    args: [],
    sql: `select count(*) as n from artist_socials
          where platform in ('spotify', 'youtube')
            and status in ('auto', 'confirmed')
            and followed_at is null`,
  });
  const remainingRow = remainingResult.rows[0] as Record<string, unknown> | undefined;
  const remaining = Number(remainingRow?.["n"] ?? 0);

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    followed,
    followedCount: followed.length,
    remaining: Number.isFinite(remaining) ? remaining : 0,
  };
}
