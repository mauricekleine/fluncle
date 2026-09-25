import { waitUntil } from "cloudflare:workers";
import { getDb, typedRows } from "./db";
import { type EntityCacheKind, purgeEntityCachesNow } from "./edge-cache";

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

  const targets: { kind: EntityCacheKind; slug: string }[] = [{ kind: "track", slug: trackId }];

  for (const row of typedRows<{ kind: unknown; slug: unknown }>(result.rows)) {
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";

    if (slug !== "" && (row.kind === "artist" || row.kind === "album" || row.kind === "label")) {
      targets.push({ kind: row.kind, slug });
    }
  }

  return targets;
}

export function purgeTrackEntityPages(trackId: string | null | undefined): void {
  if (!trackId?.trim()) {
    return;
  }

  const id = trackId.trim();

  waitUntil(getTrackEntityPurgeTargets(id).then((targets) => purgeEntityCachesNow(targets)));
}
