import { randomUUID } from "node:crypto";
import { getDb } from "./db";

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
