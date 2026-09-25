import { siteUrl } from "./fluncle-links";

export type ListenKind = "apple" | "beatport" | "deezer" | "spotify" | "youtube";

export const SAME_AS_EXCLUDED_LISTEN_KINDS: readonly ListenKind[] = ["beatport"];

export function sameAsUrls(listen: { href: string; kind: ListenKind }[]): string[] {
  return listen
    .filter((destination) => !SAME_AS_EXCLUDED_LISTEN_KINDS.includes(destination.kind))
    .map((destination) => destination.href);
}

export function trackPagePath(trackId: string): string {
  return `/track/${encodeURIComponent(trackId)}`;
}

export function trackPageUrl(trackId: string): string {
  return `${siteUrl}${trackPagePath(trackId)}`;
}

export function hasTrackPageIdentity(track: { artists: string[]; title: string }): boolean {
  return track.title.trim().length > 0 && track.artists.some((artist) => artist.trim().length > 0);
}
