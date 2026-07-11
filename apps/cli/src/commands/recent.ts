import { type MixtapeDTO, type TracksResponse, type TrackListItem } from "@fluncle/contracts";
import { publicApiGet } from "../api";

export type RecentTrack = TrackListItem;
export type RecentMixtape = MixtapeDTO;
export type RecentItem = MixtapeDTO | TrackListItem;

export type { TracksResponse };

// /api/tracks caps a single page at 48. `recent` only ever wants the newest few,
// but an explicit `--limit` above the page cap pages through with the cursor so
// the requested count is honoured rather than silently clipped at one page.
const pageSize = 48;

// The API row IS the shape the CLI emits — this is a PASSTHROUGH by design, never a
// re-projection. The server already owns the whole projection: it sets the `type`
// discriminator (`toTrackListItem`) and enforces the public/private boundary
// (`toPublicTrackListItem` strips PRIVATE_TRACK_FIELDS before any public read). A second,
// hand-maintained field whitelist here could only ever LOSE data, and twice it did —
// it dropped `sourceAudioKey` (the embed sweep then skipped every finding as
// `no_source_audio`) and `analyzedAt` (every `admin tracks list --json` row reported the
// analysis timestamp as absent while the DB held it). NEVER re-copy fields field-by-field:
// add nothing here and a new server field reaches every CLI consumer for free.
export function mapTrack(track: RecentTrack | RecentMixtape): RecentItem {
  return track;
}

export type RecentPage = {
  nextCursor?: string;
  totalCount: number;
  tracks: RecentItem[];
};

// One page for the interactive pager: the findings at `cursor` (newest first
// from the start), plus the cursor for the page after and the archive total so
// the pager can show "11–20 of 26".
export async function fetchRecentPage(cursor?: string, limit = 10): Promise<RecentPage> {
  const params = new URLSearchParams({ limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await publicApiGet<TracksResponse>(`/api/tracks?${params.toString()}`);

  return {
    nextCursor: response.nextCursor,
    totalCount: response.totalCount,
    tracks: response.tracks.map(mapTrack),
  };
}

// The latest findings, newest first. Pages through with the cursor only when
// `limit` exceeds one API page; the common small `limit` is a single request.
export async function recentCommand(limit: number): Promise<RecentItem[]> {
  const results: RecentItem[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(pageSize) });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await publicApiGet<TracksResponse>(`/api/tracks?${params.toString()}`);

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
