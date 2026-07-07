import { describe, expect, it } from "vitest";
import { parseSpotifyTrackId, spotifyTrackIdOf } from "./spotify-track-id";

const ID = "4uLU6hMCjMI75M1A2tKUQC";

describe("parseSpotifyTrackId", () => {
  it("parses a plain track URL", () => {
    expect(parseSpotifyTrackId(`https://open.spotify.com/track/${ID}`)).toEqual({
      ok: true,
      trackId: ID,
    });
  });

  it("parses a track URL with a share query string", () => {
    expect(parseSpotifyTrackId(`https://open.spotify.com/track/${ID}?si=abc123`)).toEqual({
      ok: true,
      trackId: ID,
    });
  });

  it("parses a spotify: URI", () => {
    expect(parseSpotifyTrackId(`spotify:track:${ID}`)).toEqual({ ok: true, trackId: ID });
  });

  it("rejects free text as not_a_url", () => {
    expect(parseSpotifyTrackId("camo & krooked")).toEqual({ ok: false, reason: "not_a_url" });
  });

  it("rejects a non-Spotify host as wrong_host", () => {
    expect(parseSpotifyTrackId(`https://example.com/track/${ID}`)).toEqual({
      ok: false,
      reason: "wrong_host",
    });
  });

  it("rejects a non-track Spotify link as not_a_track", () => {
    expect(parseSpotifyTrackId("https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3")).toEqual({
      ok: false,
      reason: "not_a_track",
    });
  });

  // The server grammar (parseSpotifyTrackUrl) never accepted locale-prefixed
  // paths; the shared parser must reject them identically so the client never
  // green-lights a paste the server would 400.
  it("rejects a locale-prefixed track link, matching the server grammar", () => {
    expect(parseSpotifyTrackId(`https://open.spotify.com/intl-nl/track/${ID}`)).toEqual({
      ok: false,
      reason: "not_a_track",
    });
  });

  it("rejects a malformed track id", () => {
    expect(parseSpotifyTrackId("https://open.spotify.com/track/tooshort")).toEqual({
      ok: false,
      reason: "not_a_track",
    });
  });
});

describe("spotifyTrackIdOf", () => {
  it("returns the id for a valid paste, trimming whitespace", () => {
    expect(spotifyTrackIdOf(`  https://open.spotify.com/track/${ID} `)).toBe(ID);
  });

  it("returns undefined for an invalid paste", () => {
    expect(spotifyTrackIdOf("not a link")).toBeUndefined();
  });
});
