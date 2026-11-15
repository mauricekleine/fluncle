import {
  trackPageIndexableCountQueryWhere,
  trackPageIndexableWhere,
  type TrackPageIndexableDestination,
} from "../../db/track-page-indexability";
import { listedArtistWhere } from "./artist-visibility";

export const TRACK_SITEMAP_MIN_ARTIST_TRACKS = 200;

export function trackSitemapWhere(destination?: TrackPageIndexableDestination): string {
  const indexable =
    destination === undefined
      ? trackPageIndexableWhere("tracks")
      : trackPageIndexableCountQueryWhere(destination, "tracks");

  return `${indexable} and exists (
    select 1 from track_artists sitemap_credit
    join artists sitemap_artist on sitemap_artist.id = sitemap_credit.artist_id
    where sitemap_credit.track_id = tracks.track_id
      and sitemap_artist.renderable_track_count >= ${TRACK_SITEMAP_MIN_ARTIST_TRACKS}
      and ${listedArtistWhere("sitemap_artist")}
  )`;
}

export const TRACK_SITEMAP_WHERE = trackSitemapWhere();
