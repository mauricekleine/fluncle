// Pure, client-safe plan → tools export formatters. No runtime dependencies; no
// file I/O. Each formatter takes an ordered array of track objects and returns a
// string (or string[]) the operator can paste, click, or load directly.
//
// The pyrekordbox direct-DB-write is a separate operator-Mac script (Wave 3 of the
// Plan → Recording → Mixtape RFC) — NOT this layer.

import { trackLabel } from "../util";

/** The minimal track shape all formatters share. */
export type TrackInput = { artists: string[]; title: string };

/** Join multiple artists with `, ` (the Fluncle multi-artist separator). */
export function formatArtists(artists: string[]): string {
  return artists.join(", ");
}

/**
 * One Beatport search URL per track, URL-encoded.
 *
 * Format: `https://www.beatport.com/search?q=<artist(s)%20title>`.
 *
 * Beatport has no open add-to-cart API (partner-gated), so this collapses
 * retyping into clicking: the operator clicks each link to buy.
 */
export function beatportSearchLinks(tracks: TrackInput[]): string[] {
  return tracks.map(({ artists, title }) => {
    const q = encodeURIComponent(`${formatArtists(artists)} ${title}`);
    return `https://www.beatport.com/search?q=${q}`;
  });
}

/**
 * An `#EXTM3U` extended-M3U playlist string for the ordered tracklist.
 *
 * @note This carries metadata only — no local file paths, because Fluncle does
 * not know where the operator's audio files live on disk. It is a reference list
 * (a labelled cue sheet), not a Rekordbox-loadable-with-audio file. That is the
 * pyrekordbox script's job (Wave 3).
 */
export function m3u8(tracks: TrackInput[], opts?: { title?: string }): string {
  const lines: string[] = ["#EXTM3U"];
  if (opts?.title) {
    lines.push(`#PLAYLIST:${opts.title}`);
  }
  for (const { artists, title } of tracks) {
    lines.push(`#EXTINF:-1,${trackLabel(artists, title)}`);
  }
  return lines.join("\n");
}

/**
 * A plain numbered checklist: `1. Artist(s) — Title`, one per line.
 * Copy-paste-friendly; works in notes, emails, or a USB folder README.
 */
export function checklist(tracks: TrackInput[]): string {
  return tracks
    .map(({ artists, title }, index) => `${index + 1}. ${trackLabel(artists, title)}`)
    .join("\n");
}
