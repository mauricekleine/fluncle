import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SearchFilters } from "@fluncle/contracts/orpc";

// The sonic surface's sonar seam, mocked at exactly the boundary this slice introduced (`./sonar`):
//   - flag OFF ⇒ the existing Turso scan runs and the sonar client is NEVER called;
//   - flag ON + sonar answers ⇒ the rows are hydrated IN SONAR'S ORDER, the vector scan is skipped;
//   - flag ON + a filter sonar cannot express faithfully ⇒ it falls back (sonar NOT called), so the
//     flag flip can never silently drop a filter.
// The DB is mocked so the test states EXACTLY which rows hydrate; the real vector SQL is proven in
// search.integration.test.ts.

const isSonarSonicEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarArtistsEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarLogEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./sonar", () => ({
  isSonarArtistsEnabled,
  isSonarLogEnabled,
  isSonarSonicEnabled,
  searchSonar,
}));

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

import { rankTracksByVector } from "./search";

/** A minimal `SEARCH_SELECT`-shaped row; only the fields the assertions read need be real. */
function row(trackId: string) {
  return {
    album: null,
    album_image_url: null,
    artists_json: "[]",
    bpm: null,
    galaxy_name: null,
    key: null,
    label: null,
    log_id: null,
    release_date: null,
    spotify_url: null,
    title: trackId,
    track_id: trackId,
  };
}

const PROBE = [0.1, 0.2, 0.3];
const NO_FILTERS: SearchFilters = {};

beforeEach(() => {
  isSonarSonicEnabled.mockReset();
  searchSonar.mockReset();
  execute.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("rankTracksByVector — the sonar route (dark)", () => {
  it("flag OFF: runs the Turso scan and never calls the sonar client", async () => {
    isSonarSonicEnabled.mockResolvedValue(false);
    // The one DB call is the Turso vector scan; it returns rows in scan order.
    execute.mockResolvedValue({ rows: [row("t1"), row("t2")] });

    const hits = await rankTracksByVector(PROBE, NO_FILTERS, undefined, 5);

    expect(searchSonar).not.toHaveBeenCalled();
    expect(hits.map((hit) => hit.trackId)).toEqual(["t1", "t2"]);
  });

  it("flag ON: routes to sonar and hydrates the ids IN SONAR'S ORDER", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([
      { id: "t2", score: 0.9 },
      { id: "t1", score: 0.8 },
    ]);
    // Hydration returns the rows in a DIFFERENT (DB) order — the output must follow sonar, not this.
    execute.mockResolvedValue({ rows: [row("t1"), row("t2")] });

    const hits = await rankTracksByVector(PROBE, NO_FILTERS, "anchor", 5);

    expect(searchSonar).toHaveBeenCalledWith({
      excludeIds: ["anchor"],
      filter: {},
      index: "tracks",
      probes: [PROBE],
      topK: 5,
    });
    expect(hits.map((hit) => hit.trackId)).toEqual(["t2", "t1"]);
  });

  it("flag ON with BPM bounds: maps them to sonar's inclusive bpm filter", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([{ id: "t1", score: 0.7 }]);
    execute.mockResolvedValue({ rows: [row("t1")] });

    await rankTracksByVector(PROBE, { bpmMax: 176, bpmMin: 170 }, undefined, 5);

    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { bpm_max: 176, bpm_min: 170 } }),
    );
  });

  it("flag ON but a non-BPM filter present: falls back to Turso (sonar NOT called)", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);
    execute.mockResolvedValue({ rows: [row("t1")] });

    const hits = await rankTracksByVector(PROBE, { label: "Hospital Records" }, undefined, 5);

    expect(searchSonar).not.toHaveBeenCalled();
    expect(hits.map((hit) => hit.trackId)).toEqual(["t1"]);
  });

  it("flag ON but sonar returns empty: falls back to the Turso scan", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([]);
    // Both the sonar attempt (empty) and the Turso fallback read the DB; the fallback's rows win.
    execute.mockResolvedValue({ rows: [row("t9")] });

    const hits = await rankTracksByVector(PROBE, NO_FILTERS, undefined, 5);

    expect(searchSonar).toHaveBeenCalledOnce();
    expect(hits.map((hit) => hit.trackId)).toEqual(["t9"]);
  });

  it("flag ON but sonar returns null (down/unprovisioned): falls back to the Turso scan", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue(null);
    execute.mockResolvedValue({ rows: [row("t9")] });

    const hits = await rankTracksByVector(PROBE, NO_FILTERS, undefined, 5);

    expect(hits.map((hit) => hit.trackId)).toEqual(["t9"]);
  });
});
