import { logPageUrl } from "./fluncle-links";
import { type FreshTrack } from "./server/fresh";

export function itemTitle(track: FreshTrack): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

export function itemLink(track: FreshTrack): string | undefined {
  if (track.certified && track.logId) {
    return logPageUrl(track.logId);
  }
  return track.spotifyUrl;
}

export function itemId(track: FreshTrack, link: string | undefined): string {
  return link ?? `urn:fluncle:release:${track.releaseDate}:${encodeURIComponent(itemTitle(track))}`;
}

export function releaseInstant(releaseDate: string): Date | undefined {
  if (!releaseDate) {
    return undefined;
  }
  const parsed = new Date(`${releaseDate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
