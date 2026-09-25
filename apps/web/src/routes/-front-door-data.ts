import { type TrackListItem } from "@fluncle/contracts";
import { type FreshRelease, newestFreshReleases } from "@/lib/fresh-releases";
import { type FrontDoorCounts } from "@/lib/front-door";
import { countIndexableAlbums } from "@/lib/server/albums";
import { countIndexableArtists } from "@/lib/server/artists";
import { type FreshReleases, listFreshReleases } from "@/lib/server/fresh";
import { countIndexableLabels } from "@/lib/server/labels";
import { getLiveState, type LiveState } from "@/lib/server/live";
import { countAllTracks } from "@/lib/server/tracks-hub";
import { releaseTodayUtc } from "@/lib/server/release-day";
import { listTracks, toPublicTrackListItem } from "@/lib/server/tracks";

export const FRONT_DOOR_FINDINGS = 6;

export const FRONT_DOOR_RELEASES = 8;

export const FRONT_DOOR_RELEASE_ROWS = 60;

export { type FrontDoorCounts } from "@/lib/front-door";

export type FrontDoorData = {
  counts: FrontDoorCounts;

  findings: TrackListItem[];

  findingsTotal: number;

  lead: TrackListItem | undefined;
  live: LiveState;

  releases: FreshRelease[];

  releaseWindowDays: number;
};

async function frontDoorReleases(now: Date, head: FreshReleases): Promise<FreshRelease[]> {
  const releases = newestFreshReleases(head, FRONT_DOOR_RELEASES);

  if (releases.length >= FRONT_DOOR_RELEASES || head.coverage.kind === "complete") {
    return releases;
  }

  return newestFreshReleases(await listFreshReleases(now), FRONT_DOOR_RELEASES);
}

export async function loadFrontDoorData(now: Date = new Date()): Promise<FrontDoorData> {
  const releaseThrough = releaseTodayUtc(now);
  const [leadPage, findingsPage, fresh, tracks, artists, labels, albums, live] = await Promise.all([
    listTracks({ countTotal: false, hasNote: true, lean: true, limit: 1, releaseThrough }),

    listTracks({ lean: true, limit: FRONT_DOOR_FINDINGS + 1, releaseThrough }),

    listFreshReleases(now, { catalogueLimit: FRONT_DOOR_RELEASE_ROWS }),

    countAllTracks(now),
    countIndexableArtists(),
    countIndexableLabels(),
    countIndexableAlbums(),

    getLiveState(),
  ]);

  const leadRow = leadPage.tracks[0] ?? findingsPage.tracks[0];
  const lead = leadRow ? toPublicTrackListItem(leadRow) : undefined;
  const findings = findingsPage.tracks
    .map(toPublicTrackListItem)
    .filter((finding) => finding.trackId !== lead?.trackId)
    .slice(0, FRONT_DOOR_FINDINGS);

  return {
    counts: { albums, artists, labels, tracks },
    findings,
    findingsTotal: findingsPage.totalCount,
    lead,
    live,
    releaseWindowDays: fresh.windowDays,
    releases: await frontDoorReleases(now, fresh),
  };
}
