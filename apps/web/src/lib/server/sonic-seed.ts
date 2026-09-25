// Whether a track has a sound to start "Similar tracks" from — the one fact the row's ⋮ menu and
// the player need to offer the action or hide it (decisions Q29).
//
// A track is a sonic seed when it carries its own MuQ embedding, or when a credited performer has an
// artist centroid the sonic view can fall back to (`searchLikeTrack` in `search.ts` takes the first
// performer that has one). One indexed probe per row: `has_embedding` short-circuits the common
// case, and the fallback rides `track_artists_track_id_idx` and the `artist_centroids` primary key.

/** The projection column `sonic_seed` (1 or 0), for any read whose `from` names `tracks`. */
export const SONIC_SEED_SELECT = `(tracks.has_embedding = 1 or exists (
    select 1 from track_artists seed_ta
    join artist_centroids seed_ac on seed_ac.artist_id = seed_ta.artist_id
    where seed_ta.track_id = tracks.track_id and seed_ta.role is null
  )) as sonic_seed`;

/** The DTO bit: absent when the read did not project the column, so an unknown never hides it. */
export function sonicSeedFlag(value: unknown): boolean | undefined {
  return value === null || value === undefined ? undefined : Number(value) === 1;
}
