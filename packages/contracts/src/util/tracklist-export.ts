import { trackLabel } from "../util";

export type TrackInput = { artists: string[]; title: string };

export function formatArtists(artists: string[]): string {
  return artists.join(", ");
}

export function beatportSearchLinks(tracks: TrackInput[]): string[] {
  return tracks.map(({ artists, title }) => {
    const q = encodeURIComponent(`${formatArtists(artists)} ${title}`);
    return `https://www.beatport.com/search?q=${q}`;
  });
}

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

export function checklist(tracks: TrackInput[]): string {
  return tracks
    .map(({ artists, title }, index) => `${index + 1}. ${trackLabel(artists, title)}`)
    .join("\n");
}
