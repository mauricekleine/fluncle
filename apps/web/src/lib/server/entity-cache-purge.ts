import { waitUntil } from "cloudflare:workers";
import { getDb, typedRows } from "./db";
import { type EntityCacheKind, purgeEntityCachesNow } from "./edge-cache";

// The track → entity-page cache purge, kept in a SERVER-ONLY module.
//
// `edge-cache.ts` (and the `cloudflare:workers` runtime it imports) must never enter the
// client bundle. The write modules that trigger this (`track-update.ts`, `publish.ts`) are
// server-only, but `tracks.ts` — where a track's slugs are otherwise resolved — is reachable
// from the client graph (it exports DTO shapes/helpers), so a `cloudflare:workers` import
// there breaks the browser build. This module isolates the Worker-only purge so only
// server-only callers ever pull it in.

/**
 * The public entity detail pages a single track renders on — its artist(s), its album, and
 * its label, by their CURRENT stored slug. Resolved in one query (three `union` branches over
 * the same join graph the pages read: `track_artists→artists.slug`, `tracks.album_id→
 * albums.slug`, `tracks.label_id→labels.slug`). A track links to several artists, so this
 * can return several `artist` targets. Reading the real stored slug — never re-slugifying a
 * name — keeps the purge key byte-identical to the read key.
 */
export async function getTrackEntityPurgeTargets(
  trackId: string,
): Promise<{ kind: EntityCacheKind; slug: string }[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId, trackId, trackId],
    sql: `select 'artist' as kind, artists.slug as slug
            from track_artists
            join artists on artists.id = track_artists.artist_id
           where track_artists.track_id = ? and artists.slug is not null
          union
          select 'album' as kind, albums.slug as slug
            from tracks
            join albums on albums.id = tracks.album_id
           where tracks.track_id = ? and albums.slug is not null
          union
          select 'label' as kind, labels.slug as slug
            from tracks
            join labels on labels.id = tracks.label_id
           where tracks.track_id = ? and labels.slug is not null`,
  });

  const targets: { kind: EntityCacheKind; slug: string }[] = [];

  for (const row of typedRows<{ kind: unknown; slug: unknown }>(result.rows)) {
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";

    if (slug !== "" && (row.kind === "artist" || row.kind === "album" || row.kind === "label")) {
      targets.push({ kind: row.kind, slug });
    }
  }

  return targets;
}

/**
 * Purge the cached entity detail pages a track change can stale — its artist(s), album, and
 * label pages — after a write to that track/finding (a note/cover/enrichment edit, a publish).
 * Fire-and-forget: the slug resolution + purge ride a single `waitUntil`, so the write path
 * never awaits either. Mirrors `purgeLogCache` (the same write already purges `/log/<id>`),
 * covering the OTHER surfaces that render the finding. No-op on a blank trackId.
 */
export function purgeTrackEntityPages(trackId: string | null | undefined): void {
  if (!trackId?.trim()) {
    return;
  }

  const id = trackId.trim();

  waitUntil(getTrackEntityPurgeTargets(id).then((targets) => purgeEntityCachesNow(targets)));
}
