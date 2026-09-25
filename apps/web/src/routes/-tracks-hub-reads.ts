import { type SearchStyle } from "@/lib/search-styles";
import {
  type TracksHubFilters,
  countAllTracks,
  listTracksHubPage,
  listTracksHubSoundPage,
  listTracksHubYearLane,
} from "@/lib/server/tracks-hub";

export async function readTracksHubAtOneTime(
  filters: TracksHubFilters,
  page: number,
  yearFiltered: boolean,
  hasFilters: boolean,
  clock: () => Date = () => new Date(),
) {
  const now = clock();
  return Promise.all([
    listTracksHubPage(filters, page, now),
    yearFiltered ? Promise.resolve([]) : listTracksHubYearLane(filters, now),
    hasFilters ? countAllTracks(now) : Promise.resolve(-1),
  ]);
}

/** The `?sound=` page and the whole held count, on the same UTC boundary. */
export async function readTracksHubSoundAtOneTime(
  filters: TracksHubFilters,
  style: SearchStyle,
  page: number,
  clock: () => Date = () => new Date(),
) {
  const now = clock();
  return Promise.all([listTracksHubSoundPage(filters, style, page, now), countAllTracks(now)]);
}
