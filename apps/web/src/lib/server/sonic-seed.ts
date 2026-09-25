import { listedArtistWhere } from "./artist-visibility";

export function leadCentroidArtistSql(trackIdSql: string): string {
  return `(select seed_ta.artist_id
      from track_artists seed_ta
      join artists seed_a on seed_a.id = seed_ta.artist_id
      join artist_centroids seed_ac on seed_ac.artist_id = seed_a.id
      where seed_ta.track_id = ${trackIdSql}
        and seed_ta.role is null
        and ${listedArtistWhere("seed_a")}
      order by seed_ta.position asc
      limit 1)`;
}

export const SONIC_SEED_SELECT = `(tracks.has_embedding = 1 or ${leadCentroidArtistSql("tracks.track_id")} is not null) as sonic_seed`;

export function sonicSeedFlag(value: unknown): boolean | undefined {
  return value === null || value === undefined ? undefined : Number(value) === 1;
}
