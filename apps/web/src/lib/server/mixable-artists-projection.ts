import { type MixArtist } from "@fluncle/contracts";
import { type Client } from "@libsql/client/web";
import { listedArtistWhere } from "./artist-visibility";
import { typedRows } from "./db";

export const MIXABLE_ARTISTS_PROJECTION_STATE_KEY = "mixable_artists_projection_v1_state";
export const MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE = "complete:v1";

type MixableArtistProjectionRow = {
  image_url: null | string;
  name: null | string;
  slug: null | string;
  track_count: bigint | number | null;
};

async function isProjectionReady(client: Client): Promise<boolean> {
  const result = await client.execute({
    args: [MIXABLE_ARTISTS_PROJECTION_STATE_KEY, MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE],
    sql: `select exists(select 1 from settings where key = ? and value = ?) as ready`,
  });
  return Number(result.rows[0]?.["ready"] ?? 0) === 1;
}

// BOTH ARMS CARRY THE VISIBILITY GATE. The picker is a PUBLIC name search that renders an
// artist's name and photo and writes the picked slug into a shareable URL, so an artist a global
// `unlisted` rule has taken off the site must not appear in either. The gate also decides what a
// URL that already carries an unlisted slug shows: the picker pre-selects by filtering THIS list
// (`taste-picker.tsx`), so an unlisted slug resolves to no tile at all rather than a named one.
// The set seeded from it still opens — `getMixOpeners` returns TRACKS, and a track is untouched
// by a visibility ruling.

function legacyQuery(q: string): string {
  return `select artists.name as name, artists.slug as slug, artists.image_url as image_url,
                 count(*) as track_count
          from artists
          join track_artists on track_artists.artist_id = artists.id
          join tracks on tracks.track_id = track_artists.track_id
          where tracks.key is not null
            and tracks.has_embedding = 1
            and ${listedArtistWhere("artists")}
            ${q ? "and artists.name like ? collate nocase" : ""}
          group by artists.id
          order by track_count desc, artists.name asc
          limit ?`;
}

export function mixableArtistsProjectionQuery(q: string): string {
  // The gate tests `slug`, which `artists_mixable_order_idx` carries, so the pinned
  // `indexed by` access path still serves the order and the scan
  // (`mixable-artists-projection.integration.test.ts` EXPLAINs it).
  return `select artists.name, artists.slug, artists.image_url,
                 artists.rankable_track_count as track_count
          from artists indexed by artists_mixable_order_idx
          where artists.rankable_track_count > 0
            and ${listedArtistWhere("artists")}
            ${q ? "and artists.name like ? collate nocase" : ""}
          order by -artists.rankable_track_count asc, artists.name asc
          limit ?`;
}

/**
 * Read the artist-grain mix projection only after its post-deploy reconciliation fence is complete.
 * Before cutover, fall back to the exact source query: slower, but semantically closed and never an
 * incomplete all-zero answer.
 *
 * The fence is re-read on EVERY call — not memoized — so an already-running isolate observes
 * activation without a redeploy. That is one `settings` primary-key point read per call, on a table
 * that does not grow; it is deliberately not the isolate-level memo `key-histogram.ts` uses, because
 * caching the true answer would also cache the false one somewhere and the whole point of this read
 * is that a flip is picked up live.
 */
export async function readMixableArtistsProjection(
  client: Client,
  options: { limit: number; q: string },
): Promise<MixArtist[]> {
  const ready = await isProjectionReady(client);
  const result = await client.execute({
    args: options.q ? [`%${options.q}%`, options.limit] : [options.limit],
    sql: ready ? mixableArtistsProjectionQuery(options.q) : legacyQuery(options.q),
  });
  const rows = typedRows<MixableArtistProjectionRow>(result.rows);
  return rows.flatMap((row) => {
    if (typeof row.name !== "string" || typeof row.slug !== "string") {
      return [];
    }

    return [
      {
        imageUrl: row.image_url ?? undefined,
        name: row.name,
        slug: row.slug,
        trackCount: Number(row.track_count ?? 0),
      },
    ];
  });
}
