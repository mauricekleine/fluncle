import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupSpotifyIdsByMbid } from "./listenbrainz";

// The ListenBrainz labs client is a pure network→shape mapper that must NEVER throw. Every unhappy
// path remains a fall-through to Apify, but its discriminator is the evidence the anchor summary
// needs to tell "ListenBrainz had nothing" apart from "the free rung itself failed".

// One entry of the labs response, in the exact shape the endpoint returns — note it carries NO ISRC
// and NO duration, which is why an id it returns is only a CANDIDATE the caller must verify.
const HIT = [
  {
    artist_name: "Rick Astley",
    recording_mbid: "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae",
    release_name: "Whenever You Need Somebody",
    spotify_track_ids: ["6bnZlZvEmocCLdp0622Idi", "0y8ngXGlfJ8kLa8h1d2MPr"],
    track_name: "Never Gonna Give You Up",
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupSpotifyIdsByMbid", () => {
  it("maps a hit to its spotify track ids (most-canonical first) + the labs echo", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(HIT));
    vi.stubGlobal("fetch", fetchMock);

    const match = await lookupSpotifyIdsByMbid("8f3471b5-7e6a-48da-86a9-c1c07a0f47ae");

    expect(match).toEqual({
      match: {
        artistName: "Rick Astley",
        recordingMbid: "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae",
        spotifyTrackIds: ["6bnZlZvEmocCLdp0622Idi", "0y8ngXGlfJ8kLa8h1d2MPr"],
        trackName: "Never Gonna Give You Up",
      },
      outcome: "match",
    });

    // It POSTs the identified User-Agent + the single-MBID body to the `/json` endpoint.
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://labs.api.listenbrainz.org/spotify-id-from-mbid/json");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as { headers: Record<string, string> }).headers["User-Agent"]).toBe(
      "Fluncle/1.0 (+https://www.fluncle.com)",
    );
    expect(JSON.parse((init as { body: string }).body)).toEqual([
      { recording_mbid: "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae" },
    ]);
  });

  it("distinguishes a clean no-map (the endpoint answers [])", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));

    expect(await lookupSpotifyIdsByMbid("00000000-0000-0000-0000-000000000000")).toEqual({
      outcome: "no-map",
    });
  });

  it("distinguishes a mapped entry whose spotify_track_ids list is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json([{ recording_mbid: "abc", spotify_track_ids: [] }])),
    );

    expect(await lookupSpotifyIdsByMbid("abc")).toEqual({ outcome: "empty-ids" });
  });

  it("trims + drops blank/non-string ids, keeping only real ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json([{ recording_mbid: "abc", spotify_track_ids: ["  keep  ", "", null] }]),
        ),
    );

    expect(await lookupSpotifyIdsByMbid("abc")).toMatchObject({
      match: { spotifyTrackIds: ["keep"] },
      outcome: "match",
    });
  });

  it("distinguishes valid JSON with a non-array body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ oops: true })));

    expect(await lookupSpotifyIdsByMbid("abc")).toEqual({ outcome: "non-array-body" });
  });

  it("distinguishes a non-2xx response (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));

    expect(await lookupSpotifyIdsByMbid("abc")).toEqual({ outcome: "request-failed" });
  });

  it("distinguishes fetch throwing (a network error / a timeout abort)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    expect(await lookupSpotifyIdsByMbid("abc")).toEqual({ outcome: "request-threw" });
  });

  it("distinguishes malformed JSON from the other response failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));

    expect(await lookupSpotifyIdsByMbid("abc")).toEqual({ outcome: "malformed-body" });
  });

  it("distinguishes a blank MBID without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupSpotifyIdsByMbid("   ")).toEqual({ outcome: "invalid-mbid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
