import { type MixtapeDTO } from "@/lib/mixtapes";
import { getArtistSlugMap } from "@/lib/server/artists";
import { isGalaxyMapFullyNamed } from "@/lib/server/galaxies-map";
import { resolveLogPageTarget } from "@/lib/server/log-resolver";
import {
  getSimilarFindings,
  getTrackNeighbors,
  toPublicTrackListItem,
  type TrackListItem,
  type TrackNeighbor,
} from "@/lib/server/tracks";

export type LogPageData =
  | {
      status: "found";

      artistSlugs: Record<string, string>;

      galaxyReady: boolean;
      newer?: TrackNeighbor;
      older?: TrackNeighbor;
      similar: TrackListItem[];
      track: TrackListItem;
    }
  | {
      mixtape: MixtapeDTO;
      status: "found-mixtape";
    }
  | { status: "missing" }
  | { status: "moved"; logId: string };

export async function resolveLogPageData(logId: string): Promise<LogPageData> {
  const target = await resolveLogPageTarget(logId);

  if (!target) {
    return { status: "missing" };
  }

  if (target.kind === "mixtape") {
    return { mixtape: target.mixtape, status: "found-mixtape" };
  }

  const { track } = target;

  if (!track.logId) {
    return { status: "missing" };
  }

  if (track.logId !== logId) {
    return { logId: track.logId, status: "moved" };
  }

  const [neighbors, similar, artistSlugs, galaxyReady] = await Promise.all([
    getTrackNeighbors(track),
    getSimilarFindings(track.logId).catch(() => []),
    getArtistSlugMap(track.trackId),
    isGalaxyMapFullyNamed(),
  ]);

  return {
    ...neighbors,
    artistSlugs,
    galaxyReady,
    similar,
    status: "found",
    track: toPublicTrackListItem(track),
  };
}
