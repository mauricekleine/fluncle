import { type FreshAlbum, type FreshTrack, type FreshTracksResponse } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { printJson } from "../output";

/** Which cut of the fresh list to show — the CLI/MCP twin of the `/fresh` page's `?view=` pills.
    `all` (default) shows both; `tracks` the release stream; `albums` the records they sit on. */
export type FreshView = "albums" | "all" | "tracks";

// The absence marker for the coordinate column when a row has no Log ID (the
// Unlit Rule) — an em dash as a "no value" cell, keeping the column aligned. The
// only VOICE.md-sanctioned em dash is the `Artist — Title` separator below.
const COORD_FALLBACK = "—";

// The release-date axis, NOT the Found axis: the coordinate leads only when the
// server already stamped one. A `certified: false` catalogue row carries no
// `logId` (the Unlit Rule — the DTO makes `logId` present ⇔ `certified`), so it
// prints WITHOUT a coordinate, never a fabricated ordinal.
function coordinate(track: FreshTrack): string {
  return track.logId ?? COORD_FALLBACK;
}

// One line per release, mirroring `recent`'s coordinate-led table but keyed to the
// RELEASE date (the Found Rule: this column is "out", never "found"):
//   241.7.3A  2026-07-18  Artist, Artist — Title
//   —         2026-07-17  Artist — Title            (uncertified: no coordinate)
// The coordinate column is padded to the widest coordinate in the set.
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

// One line per record. A fresh album is an UNLIT record — a released record with no
// Fluncle coordinate — so it is named and listed, never given an ordinal (the Unlit
// Rule). Keyed to its newest RELEASE date, the same "out, never found" axis as the tracks:
//   2026-07-18  Artist, Artist — Record Name
function albumRows(albums: FreshAlbum[]): string[] {
  return albums.map((album) => {
    const released = album.releaseDate.slice(0, 10);

    return `${released}  ${album.artists.join(", ")} — ${album.name}`;
  });
}

// The newest drum & bass RELEASES over the server's trailing window, newest release
// first, cut by `view` (the `/fresh` pills' twin). `--json` echoes the same cut: `all`
// keeps the full server payload (a PASSTHROUGH, like `recent`), a single view drops the
// other bucket — never a re-projection of the rows the server sent.
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

  // A block is headed only when BOTH cuts share the screen (`all`) — a single view already
  // named itself through the flag, so its block stands bare and stays clean to pipe.
  const blocks: string[] = [];
  if (showTracks && response.tracks.length > 0) {
    const rows = freshRows(response.tracks).join("\n");
    blocks.push(view === "all" ? `Tracks\n${rows}` : rows);
  }
  if (showAlbums && response.albums.length > 0) {
    const rows = albumRows(response.albums).join("\n");
    // The section heading reuses the `/fresh` page's ratified pill label for this exact cut (the
    // Chrome Rule: one action, one label across surfaces) — the web pill reads "Albums & EPs".
    blocks.push(view === "all" ? `Albums & EPs\n${rows}` : rows);
  }

  if (blocks.length === 0) {
    console.log(`Nothing new out in the last ${response.windowDays} days.`);
    return;
  }

  console.log(blocks.join("\n\n"));
}
