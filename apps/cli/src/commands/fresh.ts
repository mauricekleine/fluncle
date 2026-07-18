import { type FreshTrack, type FreshTracksResponse } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { printJson } from "../output";

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

// The newest drum & bass RELEASES over the server's trailing window, newest
// release first. A PASSTHROUGH by design (like `recent`): `--json` prints the raw
// server response unchanged — never a re-projection — and the human table reads
// straight off the same `FreshTrack` rows.
export async function freshCommand({
  json,
  limit,
}: {
  json: boolean;
  limit: number;
}): Promise<void> {
  const response = await publicApiGet<FreshTracksResponse>(`/api/v1/tracks/fresh?limit=${limit}`);

  if (json) {
    printJson({ ok: true, ...response });
    return;
  }

  if (response.tracks.length === 0) {
    console.log(`Nothing new out in the last ${response.windowDays} days.`);
    return;
  }

  console.log(freshRows(response.tracks).join("\n"));
}
