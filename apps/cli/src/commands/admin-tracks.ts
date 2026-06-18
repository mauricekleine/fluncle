import { adminApiGet } from "../api";
import { mapTrack, type RecentTrack, type TracksResponse } from "./recent";

// Mirrors the /api/admin/tracks page cap. The order + hasVideo filters are
// applied in SQL by listTracks; the CLI just pages through the matching rows.
const pageSize = 48;

async function fetchAdminTracks(options: {
  hasVideo?: boolean;
  max: number;
  order: "asc" | "desc";
}): Promise<RecentTrack[]> {
  const { hasVideo, max, order } = options;
  const results: RecentTrack[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(pageSize), order });

    if (hasVideo !== undefined) {
      params.set("hasVideo", String(hasVideo));
    }

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await adminApiGet<TracksResponse>(`/api/admin/tracks?${params.toString()}`);

    for (const apiTrack of response.tracks) {
      const track = mapTrack(apiTrack);

      if (track.type === "mixtape") {
        continue;
      }

      results.push(track);

      if (results.length >= max) {
        return results;
      }
    }

    cursor = response.nextCursor;
  } while (cursor);

  return results;
}

// The render queue: findings with no video yet, oldest first. The first row is
// the next finding to film (oldest-first is how the backlog is worked down).
export async function queueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ hasVideo: false, max: limit, order: "asc" });
}

export type VehicleEntry = {
  addedAt: string;
  artists: string[];
  logId?: string;
  title: string;
  vehicle?: string;
};

// Recent video vehicles, newest first — the style ledger a video agent reads to
// keep the next render from repeating a recently-used vehicle.
export async function vehiclesCommand(limit: number): Promise<VehicleEntry[]> {
  const tracks = await fetchAdminTracks({ hasVideo: true, max: limit, order: "desc" });

  return tracks.map((track) => ({
    addedAt: track.addedAt,
    artists: track.artists,
    logId: track.logId,
    title: track.title,
    vehicle: track.videoVehicle,
  }));
}
