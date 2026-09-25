import { type SearchStyle } from "@/lib/search-styles";
import { searchArchiveRateLimit, SEARCH_WINDOW_MS } from "@/lib/server/orpc/search";
import { chargeRateLimit } from "@/lib/server/rate-limit";
import { ApiError } from "@/lib/server/spotify";
import {
  type TracksHubFilters,
  type TracksHubSoundPage,
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

export async function readTracksHubSoundAtOneTime(
  filters: TracksHubFilters,
  style: SearchStyle,
  page: number,
  options: { clock?: () => Date; request?: Request } = {},
) {
  const now = (options.clock ?? (() => new Date()))();

  return Promise.all([
    rankedOrLimited(filters, style, page, now, options.request),
    countAllTracks(now),
  ]);
}

async function rankedOrLimited(
  filters: TracksHubFilters,
  style: SearchStyle,
  page: number,
  now: Date,
  request: Request | undefined,
): Promise<TracksHubSoundPage & { limited?: true }> {
  try {
    const charge = request
      ? await chargeRateLimit({
          action: "search_archive",
          limit: await searchArchiveRateLimit(),
          request,
          windowMs: SEARCH_WINDOW_MS,
        })
      : undefined;
    const ranked = await listTracksHubSoundPage(filters, style, page, now, {
      beforeVector: charge?.requireAllowed,
    });

    charge?.throwIfLimited();

    return ranked;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 429)) {
      throw error;
    }

    const { sound: _sound, ...plain } = filters;

    return {
      anchors: [],
      hub: await listTracksHubPage(plain, page, now),
      limited: true,
      ranked: false,
    };
  }
}
