import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchTracks } from "./tracks";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

type StoredTrack = {
  added_at: string;
  artists_json: string;
  log_id: string | null;
  title: string;
  track_id: string;
};

// A tiny in-memory archive the mocked DB queries against. We reproduce just the
// matching + ordering semantics of searchTracks's SQL so the test exercises the
// real function (its trim/clamp/arg-binding and row→DTO mapping) end to end.
const archive: StoredTrack[] = [
  {
    added_at: "2026-06-03T00:00:00.000Z",
    artists_json: JSON.stringify(["Calibre"]),
    log_id: "003.1.1A",
    title: "Mr Majestic",
    track_id: "track-calibre",
  },
  {
    added_at: "2026-06-02T00:00:00.000Z",
    artists_json: JSON.stringify(["Alix Perez", "Calibre"]),
    log_id: "002.5.9Z",
    title: "Forsaken",
    track_id: "track-alix",
  },
  {
    added_at: "2026-06-01T00:00:00.000Z",
    artists_json: JSON.stringify(["DJ Marky"]),
    log_id: "001.2.4B",
    title: "LK",
    track_id: "track-marky",
  },
];

function baseRow(stored: StoredTrack) {
  return {
    ...stored,
    added_to_spotify: 1,
    album: "Album",
    album_image_url: "https://example.com/cover.jpg",
    bpm: 174,
    duration_ms: 180000,
    enrichment_status: "done",
    features_json: null,
    isrc: null,
    key: null,
    label: null,
    note: null,
    popularity: null,
    posted_to_telegram: 1,
    preview_url: null,
    release_date: null,
    spotify_url: `https://open.spotify.com/track/${stored.track_id}`,
    tiktok_url: null,
    updated_at: null,
    vibe_x: null,
    vibe_y: null,
    video_model: null,
    video_model_reasoning: null,
    video_url: null,
    video_vehicle: null,
    youtube_url: null,
  };
}

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation(async (query: { args: unknown[]; sql: string }) => {
    // searchTracks binds [needle, needle, needle, needle, limit].
    const needle = String(query.args[0]);
    const limit = Number(query.args.at(-1));
    const matched = archive
      .filter(
        (t) =>
          t.track_id.toLowerCase().includes(needle) ||
          (t.log_id ?? "").toLowerCase().includes(needle) ||
          t.title.toLowerCase().includes(needle) ||
          t.artists_json.toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        a.added_at === b.added_at
          ? b.track_id.localeCompare(a.track_id)
          : b.added_at.localeCompare(a.added_at),
      )
      .slice(0, limit)
      .map(baseRow);

    return { rows: matched };
  });
});

describe("searchTracks", () => {
  it("returns [] for an empty/whitespace query without hitting the DB", async () => {
    expect(await searchTracks({ q: "   " })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("matches by title", async () => {
    const results = await searchTracks({ q: "majestic" });

    expect(results.map((t) => t.trackId)).toEqual(["track-calibre"]);
  });

  it("matches by artist", async () => {
    const results = await searchTracks({ q: "calibre" });

    // Newest-first: the Calibre solo (06-03) before the Alix Perez x Calibre (06-02).
    expect(results.map((t) => t.trackId)).toEqual(["track-calibre", "track-alix"]);
  });

  it("matches by logId", async () => {
    const results = await searchTracks({ q: "001.2.4B" });

    expect(results.map((t) => t.logId)).toEqual(["001.2.4B"]);
  });

  it("lowercases and binds q as parameters (never interpolates)", async () => {
    await searchTracks({ q: "Calibre" });

    const firstCall = execute.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error("expected execute to have been called");
    }
    const call = firstCall[0] as { args: unknown[]; sql: string };
    expect(call.args.slice(0, 4)).toEqual(["calibre", "calibre", "calibre", "calibre"]);
    expect(call.sql).not.toContain("Calibre");
  });

  it("clamps limit to a max of 50 and floors to 1", async () => {
    await searchTracks({ limit: 999, q: "track" });
    const firstCall = execute.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error("expected execute to have been called");
    }
    expect((firstCall[0] as { args: unknown[] }).args.at(-1)).toBe(50);

    await searchTracks({ limit: 0, q: "track" });
    const secondCall = execute.mock.calls[1];
    if (secondCall === undefined) {
      throw new Error("expected execute to have been called twice");
    }
    expect((secondCall[0] as { args: unknown[] }).args.at(-1)).toBe(20);
  });

  it("respects an explicit limit", async () => {
    const results = await searchTracks({ limit: 2, q: "track" });

    expect(results).toHaveLength(2);
    // Newest-first across all three findings.
    expect(results.map((t) => t.trackId)).toEqual(["track-calibre", "track-alix"]);
  });
});
