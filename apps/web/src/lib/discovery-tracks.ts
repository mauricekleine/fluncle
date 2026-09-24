// Every public list's row shape, mapped once onto the discovery row (`components/discovery-row.tsx`).
//
// One mapper per DTO, all here, so the rules every row shares are decided in one place: a finding
// is lit and opens its coordinate; a catalogue track opens its own destination when the
// destination would take it; the cover is the album's; the year comes from the release date; and a
// row can play only when it carries a live preview source (a stored preview URL or an ISRC).
//
// Client-safe: type-only imports from the server modules erase at compile time
// (docs/client-bundle.md), and the helpers it calls are pure.

import { type TrackListItem } from "@fluncle/contracts";
import { type FreshStreamEntry } from "@/components/fresh/data";
import { type QueueTrack } from "./preview-player";
import { type SearchHit } from "./search-results";
import { type SonicNeighbour } from "./server/track-page";
import { type CatalogueTrackItem } from "./server/tracks";
import { type TracksHubArtistLink, type TracksHubEntry } from "./server/tracks-hub";
import { hasTrackPageIdentity, trackPagePath } from "./track-page";
import { hasPreviewSource } from "./track-preview";

/** A named graph node on the metadata line: a GraphLink when it has a page, plain text when not. */
export type DiscoveryCredit = { name: string; slug?: string };

/**
 * Everything the row renders, and nothing it does not. Each list builds these from its own DTO
 * (the `*ToDiscoveryTrack` mappers below), so the row never learns a surface's
 * shape and every surface feeds the player the same queue.
 */
export type DiscoveryTrack = {
  artists: DiscoveryCredit[];
  /** The lead artist's portrait: the unlit row's stand-in when it has no cover of its own. */
  avatarUrl?: string;
  bpm?: number;
  /** The album cover, un-sized: the row asks `albumCoverAtSize` for its own slot. */
  coverUrl?: string;
  durationMs?: number;
  /** Where the row opens on fluncle.com: `/log/<id>` for a finding, `/track/<id>` otherwise. */
  href?: string;
  key?: string;
  label?: DiscoveryCredit;
  /** A certified finding: lit (full-colour cover, coordinate, gold heat). */
  lit: boolean;
  logId?: string;
  /** A live preview source exists (a stored preview URL or an ISRC). */
  previewable: boolean;
  spotifyUrl?: string;
  title: string;
  trackId: string;
  /** The release year, for the metadata line. */
  year?: string;
};

/** The row as the player's queued track. */
export function discoveryQueueTrack(track: DiscoveryTrack): QueueTrack {
  return {
    artists: track.artists.map((artist) => artist.name),
    coverUrl: track.coverUrl,
    href: track.href,
    id: track.trackId,
    lit: track.lit,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  };
}

/** The playable subset of a list, in order: exactly what the queue will walk. */
export function discoveryQueue(tracks: DiscoveryTrack[]): QueueTrack[] {
  return tracks.filter((track) => track.previewable).map(discoveryQueueTrack);
}

/** The release year from an ISO-ish date (`2026-09-25`, `2026-09`, `2026`), or nothing. */
export function releaseYear(date: string | undefined): string | undefined {
  const year = date?.slice(0, 4);

  return year && /^\d{4}$/.test(year) ? year : undefined;
}

function plainCredits(names: string[]): DiscoveryCredit[] {
  return names.map((name) => ({ name }));
}

function linkedCredits(links: TracksHubArtistLink[]): DiscoveryCredit[] {
  return links.map((link) => ({ name: link.name, slug: link.slug }));
}

function unlitHref(track: {
  artists: string[];
  title: string;
  trackId: string;
}): string | undefined {
  return hasTrackPageIdentity(track) ? trackPagePath(track.trackId) : undefined;
}

/** A certified finding (the lean `TrackListItem`): lit, opening its coordinate. */
export function findingToDiscoveryTrack(
  finding: TrackListItem,
  artistLinks?: TracksHubArtistLink[],
): DiscoveryTrack {
  return {
    artists: artistLinks ? linkedCredits(artistLinks) : plainCredits(finding.artists),
    bpm: finding.bpm,
    coverUrl: finding.albumImageUrl,
    durationMs: finding.durationMs || undefined,
    href: finding.logId ? `/log/${finding.logId}` : unlitHref(finding),
    key: finding.key,
    label: finding.label ? { name: finding.label, slug: finding.labelSlug } : undefined,
    lit: true,
    logId: finding.logId,
    previewable: hasPreviewSource(finding),
    spotifyUrl: finding.spotifyUrl,
    title: finding.title,
    trackId: finding.trackId,
    year: releaseYear(finding.releaseDate),
  };
}

/** A `/tracks` hub row, in the register its entry declares. */
export function hubEntryToDiscoveryTrack(entry: TracksHubEntry): DiscoveryTrack {
  if (entry.kind === "finding") {
    return findingToDiscoveryTrack(entry.finding, entry.artistLinks);
  }

  const { track } = entry;

  return {
    artists: linkedCredits(entry.artistLinks),
    avatarUrl: track.artistAvatarUrl,
    bpm: track.bpm,
    coverUrl: track.albumImageUrl,
    durationMs: track.durationMs,
    href: unlitHref(track),
    key: track.key,
    label: entry.label ? { name: entry.label, slug: entry.labelSlug } : undefined,
    lit: false,
    previewable: track.previewable,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    trackId: track.trackId,
    year: releaseYear(entry.releaseDate),
  };
}

/** A `/fresh` stream entry (also the front door's releases band). */
export function freshEntryToDiscoveryTrack(entry: FreshStreamEntry): DiscoveryTrack {
  if (entry.kind === "finding") {
    return { ...findingToDiscoveryTrack(entry.finding), avatarUrl: entry.finding.artistAvatarUrl };
  }

  const { track } = entry;

  return {
    artists: plainCredits(track.artists),
    avatarUrl: track.artistAvatarUrl,
    bpm: track.bpm,
    coverUrl: track.albumImageUrl,
    durationMs: track.durationMs,
    href: unlitHref(track),
    key: track.key,
    lit: false,
    previewable: track.previewable,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    trackId: track.trackId,
    year: releaseYear(entry.releaseDate),
  };
}

/** A search row: lit by `certified`, opening its coordinate or its destination. */
export function searchHitToDiscoveryTrack(hit: SearchHit): DiscoveryTrack {
  return {
    artists: plainCredits(hit.artists),
    bpm: hit.bpm,
    coverUrl: hit.albumImageUrl,
    durationMs: hit.durationMs,
    href: hit.certified && hit.logId ? `/log/${hit.logId}` : unlitHref(hit),
    key: hit.key,
    label: hit.label ? { name: hit.label } : undefined,
    lit: hit.certified,
    logId: hit.logId,
    previewable: hit.previewable === true,
    spotifyUrl: hit.spotifyUrl,
    title: hit.title,
    trackId: hit.trackId,
    year: releaseYear(hit.releaseDate),
  };
}

/** A catalogue track on an artist, label or album page: always unlit. */
export function catalogueTrackToDiscoveryTrack(track: CatalogueTrackItem): DiscoveryTrack {
  return {
    artists: plainCredits(track.artists),
    bpm: track.bpm,
    coverUrl: track.albumImageUrl,
    durationMs: track.durationMs,
    href: unlitHref(track),
    key: track.key,
    lit: false,
    previewable: track.previewable,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    trackId: track.trackId,
    year: releaseYear(track.releaseDate),
  };
}

/** A "Close in sound" neighbour on a track's destination: lit when it is a finding. */
export function sonicNeighbourToDiscoveryTrack(neighbour: SonicNeighbour): DiscoveryTrack {
  return {
    artists: plainCredits(neighbour.artists),
    coverUrl: neighbour.albumImageUrl,
    href: neighbour.logId ? `/log/${neighbour.logId}` : unlitHref(neighbour),
    lit: neighbour.logId !== undefined,
    logId: neighbour.logId,
    previewable: neighbour.previewable,
    spotifyUrl: neighbour.spotifyUrl,
    title: neighbour.title,
    trackId: neighbour.trackId,
  };
}
