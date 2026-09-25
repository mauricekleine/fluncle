import { type TrackListItem } from "@fluncle/contracts";
import { type FreshEntry } from "./fresh-releases";
import { type QueueTrack } from "./preview-player";
import { type SearchHit } from "./search-results";
import { type SonicNeighbour } from "./server/track-page";
import { type CatalogueTrackItem } from "./server/tracks";
import { type TracksHubArtistLink, type TracksHubEntry } from "./server/tracks-hub";
import { hasTrackPageIdentity, trackPagePath } from "./track-page";
import { hasPreviewSource } from "./track-preview";

export type DiscoveryCredit = { name: string; slug?: string };

export type DiscoveryTrack = {
  artists: DiscoveryCredit[];

  avatarUrl?: string;
  bpm?: number;

  coverUrl?: string;
  durationMs?: number;

  href?: string;
  key?: string;
  label?: DiscoveryCredit;

  lit: boolean;
  logId?: string;

  previewable: boolean;
  /** False when the track has no sound to find similar tracks from (no embedding, no artist
      centroid); absent when the list does not know, which never hides the action. */
  similar?: boolean;
  spotifyUrl?: string;
  title: string;
  trackId: string;

  year?: string;
};

export function discoveryQueueTrack(track: DiscoveryTrack): QueueTrack {
  return {
    artists: track.artists.map((artist) => artist.name),
    coverUrl: track.coverUrl,
    href: track.href,
    id: track.trackId,
    lit: track.lit,
    similar: track.similar,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  };
}

export function discoveryQueue(tracks: DiscoveryTrack[]): QueueTrack[] {
  return tracks.filter((track) => track.previewable).map(discoveryQueueTrack);
}

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
    similar: entry.similar,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
    trackId: track.trackId,
    year: releaseYear(entry.releaseDate),
  };
}

export function freshEntryToDiscoveryTrack(entry: FreshEntry): DiscoveryTrack {
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
    similar: hit.similar,
    spotifyUrl: hit.spotifyUrl,
    title: hit.title,
    trackId: hit.trackId,
    year: releaseYear(hit.releaseDate),
  };
}

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

export function sonicNeighbourToDiscoveryTrack(neighbour: SonicNeighbour): DiscoveryTrack {
  return {
    artists: plainCredits(neighbour.artists),
    bpm: neighbour.bpm,
    coverUrl: neighbour.albumImageUrl,
    durationMs: neighbour.durationMs,
    href: neighbour.logId ? `/log/${neighbour.logId}` : unlitHref(neighbour),
    key: neighbour.key,
    lit: neighbour.logId !== undefined,
    logId: neighbour.logId,
    previewable: neighbour.previewable,
    // A neighbour came out of a vector scan, so it has an embedding by construction.
    similar: true,
    spotifyUrl: neighbour.spotifyUrl,
    title: neighbour.title,
    trackId: neighbour.trackId,
    year: releaseYear(neighbour.releaseDate),
  };
}
