import {
  listSonicNeighbours,
  readTrackDestination,
  type SonicNeighbour,
  type TrackDestination,
} from "@/lib/server/track-page";

export type TrackPageData =
  | {
      neighbours: SonicNeighbour[];
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

  return {
    neighbours: await optionalSonicNeighbours(row.track.trackId),
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
