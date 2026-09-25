import { type FeedListPage } from "@fluncle/contracts";
import { FINDINGS_PAGE_SIZE } from "@/lib/findings-feed";
import { getLiveState, type LiveState } from "@/lib/server/live";
import { listTracks, toPublicTrackListItem } from "@/lib/server/tracks";

export { FINDINGS_PAGE_SIZE } from "@/lib/findings-feed";

export type FindingsData = FeedListPage & {
  live: LiveState;
  newestStoryLogId: string | undefined;
};

export async function loadFindingsData(): Promise<FindingsData> {
  const [page, latestStory, live] = await Promise.all([
    listTracks({ includeMixtapes: true, lean: true, limit: FINDINGS_PAGE_SIZE }),
    listTracks({ hasVideo: true, lean: true, limit: 1 }),

    getLiveState(),
  ]);

  return {
    ...page,
    live,
    newestStoryLogId: latestStory.tracks[0]?.logId,
    tracks: page.tracks.map(toPublicTrackListItem),
  };
}
