import {
  type TracksHubFilters,
  countAllTracks,
  listTracksHubPage,
  listTracksHubYearLane,
} from "@/lib/server/tracks-hub";

/** All release-sensitive reads in one hub response share one UTC boundary. */
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
