import { type MixtapeDTO, type TracksResponse, type TrackListItem } from "@fluncle/contracts";
import { publicApiGet } from "../api";

export type RecentTrack = TrackListItem;
export type RecentMixtape = MixtapeDTO;
export type RecentItem = MixtapeDTO | TrackListItem;

export type { TracksResponse };

const pageSize = 48;

export function mapTrack(track: RecentTrack | RecentMixtape): RecentItem {
  return track;
}

export type RecentPage = {
  nextCursor?: string;
  totalCount: number;
  tracks: RecentItem[];
};

export async function fetchRecentPage(cursor?: string, limit = 10): Promise<RecentPage> {
  const params = new URLSearchParams({ limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await publicApiGet<TracksResponse>(`/api/v1/findings?${params.toString()}`);

  return {
    nextCursor: response.nextCursor,
    totalCount: response.totalCount,
    tracks: response.tracks.map(mapTrack),
  };
}

export async function recentCommand(limit: number): Promise<RecentItem[]> {
  const results: RecentItem[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(pageSize) });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await publicApiGet<TracksResponse>(`/api/v1/findings?${params.toString()}`);

    for (const apiTrack of response.tracks) {
      results.push(mapTrack(apiTrack));

      if (results.length >= limit) {
        return results;
      }
    }

    cursor = response.nextCursor;
  } while (cursor);

  return results;
}
