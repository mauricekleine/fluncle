import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchTracks, __resetSearchCache } from "./track-search";

const execute = vi.hoisted(() => vi.fn());
const searchDeezerSubmissionTracks = vi.hoisted(() => vi.fn());
const searchTrackCandidates = vi.hoisted(() => vi.fn());

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: async () => ({ execute }),
}));

vi.mock("./deezer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./deezer")>()),
  searchDeezerSubmissionTracks,
}));

vi.mock("./spotify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spotify")>()),
  searchTrackCandidates,
}));

vi.mock("./rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rate-limit")>()),
  assertRateLimit: async () => undefined,
}));

const spotifyId = "abcdefghij0123456789AB";
const request = new Request("https://www.fluncle.com/api/v1/search?q=calibre");

beforeEach(() => {
  __resetSearchCache();
  execute.mockReset();
  execute.mockResolvedValue({ rows: [] });
  searchDeezerSubmissionTracks.mockReset();
  searchDeezerSubmissionTracks.mockResolvedValue([]);
  searchTrackCandidates.mockReset();
  searchTrackCandidates.mockResolvedValue([]);
});

describe("submission candidate search", () => {
  it("returns anchored catalogue matches first and fills with Deezer without Spotify calls", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          album: "Shelter",
          album_image_url: "https://img.example/cover.jpg",
          artists_json: '["Calibre"]',
          duration_ms: 180_000,
          isrc: "GB-AAA-22-00001",
          spotify_uri: `spotify:track:${spotifyId}`,
          spotify_url: `https://open.spotify.com/track/${spotifyId}`,
          title: "Shelter",
          track_id: "archive-id",
        },
      ],
    });
    searchDeezerSubmissionTracks.mockResolvedValue([
      { artists: ["Calibre"], id: "91", provider: "deezer", spotifyUrl: "", title: "Other Track" },
    ]);

    const results = await searchTracks({ query: "calibre", request });

    expect(results.map((result) => [result.provider, result.id])).toEqual([
      ["spotify", spotifyId],
      ["deezer", "91"],
    ]);
    expect(searchDeezerSubmissionTracks).toHaveBeenCalledWith("calibre", 8);
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });

  it("keeps an unanchored catalogue recording available for ISRC resolution on submit", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          album: null,
          album_image_url: null,
          artists_json: '["Calibre"]',
          duration_ms: 180_000,
          isrc: "GBAAA2200001",
          spotify_uri: null,
          spotify_url: null,
          title: "Shelter",
          track_id: "local-id",
        },
      ],
    });

    const results = await searchTracks({ query: "shelter", request });

    expect(results[0]).toMatchObject({ id: "local-id", provider: "catalogue", spotifyUrl: "" });
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });

  it("omits an ISRC-only catalogue recording without a duration", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          album: null,
          album_image_url: null,
          artists_json: '["Calibre"]',
          duration_ms: null,
          isrc: "GBTEST2600001",
          spotify_uri: null,
          spotify_url: null,
          title: "Shelter",
          track_id: "local-id",
        },
      ],
    });

    expect(await searchTracks({ query: "shelter", request })).toEqual([]);
  });

  it("searches Deezer when the catalogue misses and stays off Spotify", async () => {
    searchDeezerSubmissionTracks.mockResolvedValue([
      { artists: ["Netsky"], id: "42", provider: "deezer", spotifyUrl: "", title: "Rio" },
    ]);

    const results = await searchTracks({ query: "netsky rio", request });

    expect(results).toHaveLength(1);
    expect(results[0]?.provider).toBe("deezer");
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });

  it("resolves a Spotify URL through the catalogue when it is anchored", async () => {
    const url = `https://open.spotify.com/track/${spotifyId}`;
    execute.mockResolvedValue({
      rows: [
        {
          album: "Shelter",
          album_image_url: null,
          artists_json: '["Calibre"]',
          duration_ms: 180_000,
          isrc: "GBTEST2600001",
          spotify_uri: `spotify:track:${spotifyId}`,
          spotify_url: url,
          title: "Shelter",
          track_id: "archive-id",
        },
      ],
    });
    const results = await searchTracks({ query: url, request });

    expect(results).toMatchObject([{ id: spotifyId, spotifyUrl: url, title: "Shelter" }]);
    expect(searchTrackCandidates).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[0].args).toEqual([`spotify:track:${spotifyId}`]);
    expect(searchDeezerSubmissionTracks).not.toHaveBeenCalled();
  });

  it("uses Spotify only after both first tiers miss and returns its real title", async () => {
    const url = `https://open.spotify.com/track/${spotifyId}`;
    searchTrackCandidates.mockResolvedValue([
      { artists: ["Calibre"], id: spotifyId, spotifyUrl: url, title: "Shelter" },
    ]);

    expect(await searchTracks({ query: url, request })).toMatchObject([{ title: "Shelter" }]);
    expect(searchTrackCandidates).toHaveBeenCalledWith(url, "public_search");
    expect(searchDeezerSubmissionTracks).not.toHaveBeenCalled();
  });

  it("returns empty results when the Spotify fallback is deferred", async () => {
    const { SpotifyDeferredError } = await import("./spotify");
    searchTrackCandidates.mockRejectedValueOnce(
      new SpotifyDeferredError("quota_hold", "2026-10-02T09:00:00.000Z"),
    );

    expect(await searchTracks({ query: "unknown recording", request })).toEqual([]);
    expect(searchTrackCandidates).toHaveBeenCalledWith("unknown recording", "public_search");
  });

  it("deduplicates the same ISRC across catalogue and Deezer", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          album: null,
          album_image_url: null,
          artists_json: '["Calibre"]',
          duration_ms: 180_000,
          isrc: "GB-TEST-26-00001",
          spotify_uri: `spotify:track:${spotifyId}`,
          spotify_url: `https://open.spotify.com/track/${spotifyId}`,
          title: "Shelter",
          track_id: "archive-id",
        },
      ],
    });
    searchDeezerSubmissionTracks.mockResolvedValue([
      {
        artists: ["Calibre"],
        id: "91",
        isrc: "GBTEST2600001",
        provider: "deezer",
        spotifyUrl: "",
        title: "Shelter (Remastered)",
      },
    ]);

    expect(await searchTracks({ query: "shelter", request })).toHaveLength(1);
  });

  it("keeps the catalogue result when Deezer throws", async () => {
    searchDeezerSubmissionTracks.mockRejectedValue(new Error("edge egress failed"));
    searchTrackCandidates.mockResolvedValue([
      { artists: ["A"], id: spotifyId, spotifyUrl: "", title: "Spotify" },
    ]);
    execute.mockResolvedValue({
      rows: [
        {
          album: null,
          album_image_url: null,
          artists_json: '["A"]',
          duration_ms: 180_000,
          isrc: "GBTEST2600001",
          spotify_uri: `spotify:track:${spotifyId}`,
          spotify_url: `https://open.spotify.com/track/${spotifyId}`,
          title: "Shelter",
          track_id: "archive-id",
        },
      ],
    });

    expect(await searchTracks({ query: "shelter", request })).toMatchObject([{ title: "Shelter" }]);
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });
});
