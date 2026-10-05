import { type ListenKind } from "./track-page";

export type ListenLink = { href: string; kind: ListenKind };

const LISTENING_KINDS: readonly ListenKind[] = ["spotify", "apple", "deezer", "youtube"];

export function trackListenLinks(track: {
  listen?: readonly ListenLink[];
  spotifyUrl?: string;
}): ListenLink[] {
  const links: ListenLink[] = track.spotifyUrl ? [{ href: track.spotifyUrl, kind: "spotify" }] : [];

  for (const link of track.listen ?? []) {
    if (link.href && !links.some((known) => known.kind === link.kind)) {
      links.push(link);
    }
  }

  return links;
}

export function listenOutLink(track: {
  listen?: readonly ListenLink[];
  spotifyUrl?: string;
}): ListenLink | undefined {
  return trackListenLinks(track).find((link) => LISTENING_KINDS.includes(link.kind));
}
