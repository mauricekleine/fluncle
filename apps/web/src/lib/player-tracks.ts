import { type QueueTrack } from "./preview-player";
import { type SavableTrack } from "./saved-tracks";
import { hitHref, searchArchiveApiPath, searchPagePath, type SearchHit } from "./search-results";
import { hasTrackPageIdentity, trackPagePath } from "./track-page";

export const KEEP_GOING_LIMIT = 20;

export function trackCredit(track: Pick<QueueTrack, "artists" | "title">): string {
  const artists = track.artists.join(", ");

  return artists.length > 0 ? `${artists} — ${track.title}` : track.title;
}

export function savableTrack(
  track: Pick<
    QueueTrack,
    "artists" | "coverUrl" | "href" | "id" | "logId" | "spotifyUrl" | "title"
  >,
): SavableTrack {
  return {
    artists: track.artists,
    coverUrl: track.coverUrl,
    href: track.href,
    logId: track.logId,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    trackId: track.id,
  };
}

export function similarQuery(track: Pick<QueueTrack, "artists" | "title">): string {
  return `tracks that sound like ${trackCredit(track)}`;
}

export function similarSearchHref(track: Pick<QueueTrack, "artists" | "id" | "title">): string {
  return isTrackId(track.id)
    ? `/search?like=${encodeURIComponent(track.id)}`
    : searchPagePath(similarQuery(track));
}

function isTrackId(id: string): boolean {
  return !/^\d{3,}\.(?:\d|f)\./i.test(id);
}

export function toQueueTrack(row: {
  albumImageUrl?: string;
  artists: string[];
  logId?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
}): QueueTrack {
  return {
    artists: row.artists,
    coverUrl: row.albumImageUrl,
    href: row.logId
      ? `/log/${row.logId}`
      : hasTrackPageIdentity(row)
        ? trackPagePath(row.trackId)
        : undefined,
    id: row.trackId,
    lit: row.logId !== undefined,
    logId: row.logId,
    spotifyUrl: row.spotifyUrl,
    title: row.title,
  };
}

export function queueTrackFromHit(hit: SearchHit): QueueTrack {
  const destination = hitHref(hit);

  return {
    artists: hit.artists,
    coverUrl: hit.albumImageUrl,
    href: destination && !destination.external ? destination.href : undefined,
    id: hit.trackId,
    lit: hit.certified,
    logId: hit.certified ? hit.logId : undefined,
    similar: hit.similar,
    spotifyUrl: hit.spotifyUrl,
    title: hit.title,
  };
}

export async function loadSimilarTracks(last: QueueTrack): Promise<QueueTrack[]> {
  try {
    const response = await fetch(searchArchiveApiPath(similarQuery(last), KEEP_GOING_LIMIT));

    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as { kind?: string; results?: SearchHit[] };

    if (body.kind !== "sonic" || !Array.isArray(body.results)) {
      return [];
    }

    return body.results.map(queueTrackFromHit);
  } catch {
    return [];
  }
}
