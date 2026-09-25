const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;

export type SpotifyTrackIdResult =
  | { ok: true; trackId: string }
  | { ok: false; reason: "not_a_track" | "not_a_url" | "wrong_host" };

export function parseSpotifyTrackId(input: string): SpotifyTrackIdResult {
  const uriMatch = input.match(TRACK_URI);

  if (uriMatch?.[1] !== undefined) {
    return { ok: true, trackId: uriMatch[1] };
  }

  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }

  if (url.hostname !== "open.spotify.com") {
    return { ok: false, reason: "wrong_host" };
  }

  const [kind, trackId] = url.pathname.split("/").filter(Boolean);

  if (kind !== "track" || !trackId || !TRACK_ID.test(trackId)) {
    return { ok: false, reason: "not_a_track" };
  }

  return { ok: true, trackId };
}

export function spotifyTrackIdOf(input: string): string | undefined {
  const result = parseSpotifyTrackId(input.trim());

  return result.ok ? result.trackId : undefined;
}
