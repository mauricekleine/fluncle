import { releaseTodayUtc } from "@/lib/server/release-day";
import {
  listSonicNeighbours,
  readTrackDestination,
  SONIC_NEIGHBOUR_LIMIT,
  type SonicNeighbour,
  type TrackDestination,
} from "@/lib/server/track-page";
import { matchKey } from "@/lib/server/track-match";
import {
  type CatalogueTrackItem,
  type GraphFindingItem,
  listCatalogueTracksByAlbum,
  listCatalogueTracksByArtist,
  listRelatedFindings,
  RELATED_FINDINGS_LIMIT,
} from "@/lib/server/tracks";

export const TRACK_SIBLING_LIMIT = 12;

const ARTIST_SIBLING_SCAN = 48;

export type TrackSiblingBand = { name: string; tracks: CatalogueTrackItem[] };

export type TrackPageData =
  | {
      artistTracks: TrackSiblingBand | undefined;
      neighbours: SonicNeighbour[];
      recordTracks: TrackSiblingBand | undefined;
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

  const { primaryArtist } = row.graph;
  const albumId = row.track.album ? row.graph.albumId : undefined;
  const today = releaseTodayUtc(new Date());
  const [neighbours, related, record, byArtist] = await Promise.all([
    optionalSonicNeighbours(row.track.trackId),
    optionalRelatedFindings(row.track.trackId),
    albumId
      ? listCatalogueTracksByAlbum(albumId).then(
          (slice) => slice.tracks,
          (): CatalogueTrackItem[] => [],
        )
      : [],
    primaryArtist
      ? listCatalogueTracksByArtist(primaryArtist.id, {
          excludeAlbumId: albumId,
          limit: ARTIST_SIBLING_SCAN,
          today,
        }).catch((): CatalogueTrackItem[] => [])
      : [],
  ]);
  const shown = new Set(neighbours.map((neighbour) => neighbour.trackId));
  const siblings = trackSiblingBands({
    artist: primaryArtist ? { name: primaryArtist.name, tracks: byArtist } : undefined,
    neighbours,
    record: row.track.album ? { name: row.track.album.name, tracks: record } : undefined,
    track: row.track,
  });

  return {
    ...siblings,
    neighbours,
    related: related
      .filter((finding) => !shown.has(finding.trackId))
      .slice(0, RELATED_FINDINGS_LIMIT),
    status: "found",
    track: row.track,
  };
}

export function trackSiblingBands({
  artist,
  neighbours,
  record,
  track,
}: {
  artist: TrackSiblingBand | undefined;
  neighbours: { trackId: string }[];
  record: TrackSiblingBand | undefined;
  track: { artists: { name: string }[]; title: string; trackId: string };
}): { artistTracks: TrackSiblingBand | undefined; recordTracks: TrackSiblingBand | undefined } {
  const seenIds = new Set([track.trackId, ...neighbours.map((neighbour) => neighbour.trackId)]);
  const seenRecordings = new Set([
    matchKey(
      track.artists.map((credit) => credit.name),
      track.title,
    ),
  ]);

  const take = (band: TrackSiblingBand | undefined): TrackSiblingBand | undefined => {
    if (!band) {
      return undefined;
    }

    const tracks: CatalogueTrackItem[] = [];

    for (const candidate of band.tracks) {
      const recording = matchKey(candidate.artists, candidate.title);

      if (
        tracks.length < TRACK_SIBLING_LIMIT &&
        !seenIds.has(candidate.trackId) &&
        !seenRecordings.has(recording)
      ) {
        seenIds.add(candidate.trackId);
        seenRecordings.add(recording);
        tracks.push(candidate);
      }
    }

    return tracks.length > 0 ? { name: band.name, tracks } : undefined;
  };

  const recordTracks = take(record);

  return { artistTracks: take(artist), recordTracks };
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
