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

export function mapTrack(track: RecentTrack | RecentMixtape): RecentItem {
  if (track.type === "mixtape") {
    return track;
  }

  return {
    addedAt: track.addedAt,
    addedToSpotify: track.addedToSpotify,
    album: track.album,
    albumImageUrl: track.albumImageUrl,
    // Analysis provenance (RFC bpm-key-accuracy). Stripped from every PUBLIC read by
    // `toPublicTrackListItem`, so on `/api/tracks` these arrive undefined; on the ADMIN path
    // (`/api/admin/tracks`, e.g. the `requeue-analysis` sweep) they carry the real value.
    // `analyzedAt` is the analysis-write timestamp — the freshness companion to `analyzedFrom`;
    // it must be copied here too or `admin tracks list --json` silently drops it.
    analyzedAt: track.analyzedAt,
    analyzedFrom: track.analyzedFrom,
    artists: track.artists,
    bpm: track.bpm,
    // Source-hierarchy provenance (operator > rekordbox > DSP). Stripped from every PUBLIC
    // read by `toPublicTrackListItem`, so on `/api/tracks` it arrives undefined; on the ADMIN
    // path (`/api/admin/tracks`) it carries the real value — the Rekordbox sync reads it from
    // `admin tracks list --json` to skip operator-graded rows.
    bpmSource: track.bpmSource,
    durationMs: track.durationMs,
    enrichmentStatus: track.enrichmentStatus,
    isrc: track.isrc,
    key: track.key,
    keySource: track.keySource,
    label: track.label,
    logId: track.logId,
    note: track.note,
    popularity: track.popularity,
    postedToTelegram: track.postedToTelegram,
    previewUrl: track.previewUrl,
    releaseDate: track.releaseDate,
    // The private full-song capture key. The server already strips it from every PUBLIC read
    // (`toPublicTrackListItem`), so on the public `/api/tracks` path it arrives undefined and
    // JSON.stringify omits it — `fluncle recent` stays clean. The ADMIN path (`/api/admin/tracks`,
    // e.g. `embed --queue`) does NOT strip, so the on-box embed sweep gets the real key here.
    sourceAudioKey: track.sourceAudioKey,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    trackId: track.trackId,
    type: "finding",
    videoGrain: track.videoGrain,
    videoModel: track.videoModel,
    videoModelReasoning: track.videoModelReasoning,
    videoRegister: track.videoRegister,
    videoUrl: track.videoUrl,
    videoVehicle: track.videoVehicle,
  };
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
