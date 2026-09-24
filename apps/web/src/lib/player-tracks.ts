// The client-safe glue between the archive's row shapes and the preview player's queue.
//
// Every list hands the player the same small `QueueTrack`, built here or beside the list from its
// own DTO, so `lib/preview-player.ts` never learns a surface's row type. "Similar tracks" and the
// end-of-list "keep going" both ask the archive the one sonic question the resolver already
// answers deterministically (docs/search.md, tier 3½): tracks that sound like a real track.
//
// Free of React, of `lib/server/**`, and of any I/O but the one public read in
// `loadSimilarTracks`, so any route can import it (docs/client-bundle.md).

import { type QueueTrack } from "./preview-player";
import { hitHref, searchArchiveApiPath, searchPagePath, type SearchHit } from "./search-results";
import { hasTrackPageIdentity, trackPagePath } from "./track-page";

/** The most neighbours a "keep going" pulls in one go — a list's worth, not the archive. */
export const KEEP_GOING_LIMIT = 20;

/** `Artist — Title`, the tracklist credit the sonic tier anchors on. */
export function trackCredit(track: Pick<QueueTrack, "artists" | "title">): string {
  const artists = track.artists.join(", ");

  return artists.length > 0 ? `${artists} — ${track.title}` : track.title;
}

/** The sonic question for one track, in the phrasing the resolver's sonic tier reads. */
export function similarQuery(track: Pick<QueueTrack, "artists" | "title">): string {
  return `tracks that sound like ${trackCredit(track)}`;
}

/** Where "Similar tracks" goes: `/search`'s sonic view for the track. */
export function similarSearchHref(track: Pick<QueueTrack, "artists" | "title">): string {
  return searchPagePath(similarQuery(track));
}

/**
 * Any track-shaped row as a queued track. A finding opens its coordinate page, an archive track
 * its own destination (when the destination would take it), and a row with neither opens nothing.
 */
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
    spotifyUrl: row.spotifyUrl,
    title: row.title,
  };
}

/** A search row as a queued track. The page it opens is the row's own (`hitHref`). */
export function queueTrackFromHit(hit: SearchHit): QueueTrack {
  const destination = hitHref(hit);

  return {
    artists: hit.artists,
    coverUrl: hit.albumImageUrl,
    href: destination && !destination.external ? destination.href : undefined,
    id: hit.trackId,
    lit: hit.certified,
    spotifyUrl: hit.spotifyUrl,
    title: hit.title,
  };
}

/**
 * The last track's sonic neighbours, for "keep going". An archive that cannot answer (no
 * embedding for the anchor, a degraded tier, the network) answers with an empty list, and the
 * player keeps its place.
 */
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
