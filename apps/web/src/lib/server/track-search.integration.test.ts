import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";

let db: Client;
const searchDeezerSubmissionTracks = vi.hoisted(() => vi.fn());
const searchTrackCandidates = vi.hoisted(() => vi.fn());

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: async () => db,
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

beforeEach(async () => {
  db = await createIntegrationDb();
  searchDeezerSubmissionTracks.mockReset();
  searchDeezerSubmissionTracks.mockResolvedValue([]);
  searchTrackCandidates.mockReset();
  searchTrackCandidates.mockResolvedValue([]);
  const { __resetSearchCache } = await import("./track-search");
  __resetSearchCache();
});

afterEach(() => {
  db.close();
});

describe("catalogue submission candidate search", () => {
  it("uses the public FTS index for anchored and ISRC-bearing unanchored recordings", async () => {
    const anchoredId = "abcdefghij0123456789AB";
    await seedCatalogueTrack(db, {
      artists: ["Calibre"],
      title: "Solar Transit",
      trackId: anchoredId,
    });
    await seedCatalogueTrack(db, {
      artists: ["Calibre"],
      title: "Solar Transit Dub",
      trackId: "local-transit",
    });
    await db.execute({
      args: ["GBTEST2600001", "local-transit"],
      sql: "update tracks set spotify_uri = null, spotify_url = null, isrc = ? where track_id = ?",
    });
    for (let index = 0; index < 8; index += 1) {
      const trackId = `empty-transit-${index}`;
      await seedCatalogueTrack(db, {
        artists: ["Calibre"],
        title: "Solar Transit",
        trackId,
      });
      await db.execute({
        args: [trackId],
        sql: "update tracks set spotify_uri = null, spotify_url = null where track_id = ?",
      });
    }

    const { searchTracks } = await import("./track-search");
    const results = await searchTracks({
      query: "solar transit",
      request: new Request("https://www.fluncle.com/api/v1/search?q=solar+transit"),
    });

    expect(results.map((candidate) => [candidate.provider, candidate.id])).toEqual([
      ["spotify", anchoredId],
      ["catalogue", "local-transit"],
    ]);
    expect(searchDeezerSubmissionTracks).toHaveBeenCalledWith("solar transit", 8);
  });

  it.each([0, -1])(
    "omits an ISRC-only recording with duration %s from submission candidates",
    async (durationMs) => {
      await seedCatalogueTrack(db, {
        artists: ["Calibre"],
        title: "Solar Transit",
        trackId: "local-transit",
      });
      await db.execute({
        args: ["GBTEST2600001", durationMs, "local-transit"],
        sql: "update tracks set spotify_uri = null, spotify_url = null, isrc = ?, duration_ms = ? where track_id = ?",
      });

      const { searchTracks } = await import("./track-search");
      const results = await searchTracks({
        query: "solar transit",
        request: new Request("https://www.fluncle.com/api/v1/search?q=solar+transit"),
      });

      expect(results).toEqual([]);
    },
  );
});
