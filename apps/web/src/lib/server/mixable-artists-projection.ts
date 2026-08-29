import { type MixArtist } from "@fluncle/contracts";
import { type Client } from "@libsql/client/web";
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

function legacyQuery(q: string): string {
  return `select artists.name as name, artists.slug as slug, artists.image_url as image_url,
                 count(*) as track_count
          from artists
          join track_artists on track_artists.artist_id = artists.id
          join tracks on tracks.track_id = track_artists.track_id
          where tracks.key is not null
            and tracks.has_embedding = 1
            ${q ? "and artists.name like ? collate nocase" : ""}
          group by artists.id
          order by track_count desc, artists.name asc
          limit ?`;
}

export function mixableArtistsProjectionQuery(q: string): string {
  return `select artists.name, artists.slug, artists.image_url,
                 artists.rankable_track_count as track_count
          from artists indexed by artists_mixable_order_idx
          where artists.rankable_track_count > 0
            ${q ? "and artists.name like ? collate nocase" : ""}
          order by -artists.rankable_track_count asc, artists.name asc
          limit ?`;
}

/**
 * Read the artist-grain mix projection only after its post-deploy reconciliation fence is complete.
 * Before cutover, fall back to the exact source query: slower, but semantically closed and never an
 * incomplete all-zero answer. A true fence is cached for the life of the Worker isolate; false is
 * deliberately re-read so an already-running isolate observes activation without a redeploy.
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
