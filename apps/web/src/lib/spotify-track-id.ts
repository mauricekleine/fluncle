// The one Spotify track-link grammar, shared by the client and the server so the
// two can never drift: `spotify:track:<id>` URIs and `open.spotify.com/track/<id>`
// URLs, with the 22-char base62 id. The admin Add-finding dialog parses pastes
// with it (validate before the round-trip); the server's `parseSpotifyTrackUrl`
// (lib/server/spotify.ts) delegates here and maps each failure reason onto its
// exact legacy `invalid_spotify_url` message.

const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;

export type SpotifyTrackIdResult =
  | { ok: true; trackId: string }
  /**
   * Why the parse failed — the server maps each reason to its own message:
   * `not_a_url` (not a URI and not parseable as a URL), `wrong_host` (a URL,
   * but not open.spotify.com), `not_a_track` (right host, wrong path or id).
   */
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

/** The track id when the input parses, else undefined — the client-side form. */
export function spotifyTrackIdOf(input: string): string | undefined {
  const result = parseSpotifyTrackId(input.trim());

  return result.ok ? result.trackId : undefined;
}
