import { type FreshAlbum, type FreshTrack, type FreshTracksResponse } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { printJson } from "../output";

export type FreshView = "albums" | "all" | "tracks";

const COORD_FALLBACK = "—";

function coordinate(track: FreshTrack): string {
  return track.logId ?? COORD_FALLBACK;
}

function freshRows(tracks: FreshTrack[]): string[] {
  const coordWidth = tracks.reduce((width, track) => {
    return Math.max(width, coordinate(track).length);
  }, 0);

  return tracks.map((track) => {
    const released = track.releaseDate.slice(0, 10);
    const label = `${track.artists.join(", ")} — ${track.title}`;

    return `${coordinate(track).padEnd(coordWidth)}  ${released}  ${label}`;
  });
}

function albumRows(albums: FreshAlbum[]): string[] {
  return albums.map((album) => {
    const released = album.releaseDate.slice(0, 10);

    return `${released}  ${album.artists.join(", ")} — ${album.name}`;
  });
}

export async function freshCommand({
  json,
  limit,
  view,
}: {
  json: boolean;
  limit: number;
  view: FreshView;
}): Promise<void> {
  const response = await publicApiGet<FreshTracksResponse>(`/api/v1/tracks/fresh?limit=${limit}`);
  const showTracks = view !== "albums";
  const showAlbums = view !== "tracks";

  if (json) {
    const payload: {
      albums?: FreshAlbum[];
      ok: true;
      tracks?: FreshTrack[];
      windowDays: number;
    } = { ok: true, windowDays: response.windowDays };
    if (showAlbums) {
      payload.albums = response.albums;
    }
    if (showTracks) {
      payload.tracks = response.tracks;
    }
    printJson(payload);
    return;
  }

  const blocks: string[] = [];
  if (showTracks && response.tracks.length > 0) {
    const rows = freshRows(response.tracks).join("\n");
    blocks.push(view === "all" ? `Tracks\n${rows}` : rows);
  }
  if (showAlbums && response.albums.length > 0) {
    const rows = albumRows(response.albums).join("\n");

    blocks.push(view === "all" ? `Albums & EPs\n${rows}` : rows);
  }

  if (blocks.length === 0) {
    console.log(`Nothing new out in the last ${response.windowDays} days.`);
    return;
  }

  console.log(blocks.join("\n\n"));
}
