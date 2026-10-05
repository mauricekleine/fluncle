import { releaseTodayUtc } from "@/lib/server/release-day";
import {
  listSonicNeighbours,
  readTrackDestination,
  SONIC_NEIGHBOUR_LIMIT,
  type SonicNeighbour,
  type TrackDestination,
} from "@/lib/server/track-page";
import {
  type GraphFindingItem,
  listRelatedFindings,
  RELATED_FINDINGS_LIMIT,
} from "@/lib/server/tracks";

export type TrackPageData =
  | {
      neighbours: SonicNeighbour[];
      related: GraphFindingItem[];
      status: "found";
      track: TrackDestination;
    }
  | { status: "redirect"; logId?: string; trackId?: string }
  | { status: "missing" };

export async function resolveTrackPageData(trackId: string): Promise<TrackPageData> {
  const row = await readTrackDestination(trackId);

  if (row.kind === "missing") {
    return { status: "missing" };
  }

  if (row.kind === "certified") {
    return { logId: row.logId, status: "redirect" };
  }

  if (row.kind === "duplicate") {
    return { status: "redirect", trackId: row.principalTrackId };
  }

  const [neighbours, related] = await Promise.all([
    optionalSonicNeighbours(row.track.trackId),
    optionalRelatedFindings(row.track.trackId),
  ]);
  const shown = new Set(neighbours.map((neighbour) => neighbour.trackId));

  return {
    neighbours,
    related: related
      .filter((finding) => !shown.has(finding.trackId))
      .slice(0, RELATED_FINDINGS_LIMIT),
    status: "found",
    track: row.track,
  };
}

export async function optionalSonicNeighbours(
  trackId: string,
  load: (id: string) => Promise<SonicNeighbour[]> = listSonicNeighbours,
): Promise<SonicNeighbour[]> {
  try {
    return await load(trackId);
  } catch {
    return [];
  }
}

async function optionalRelatedFindings(trackId: string): Promise<GraphFindingItem[]> {
  try {
    return await listRelatedFindings(
      { kind: "track", trackId },
      { limit: RELATED_FINDINGS_LIMIT + SONIC_NEIGHBOUR_LIMIT, today: releaseTodayUtc(new Date()) },
    );
  } catch {
    return [];
  }
}
