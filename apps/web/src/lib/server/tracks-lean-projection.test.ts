import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

import { listTracks } from "./tracks";

// One fully-populated stored row — the fat read maps all three heavy fields; the lean
// read (LEAN_TRACK_SELECT) simply never SELECTs the heavy columns, so a lean row would
// arrive without them. We feed the SAME populated row to both paths and prove the lean
// MAPPER drops them regardless (the projection, not the row, is what makes it lean).
const FAT_ROW = {
  added_at: "2026-06-01T00:00:00.000Z",
  added_to_spotify: 0,
  album: "Album",
  album_image_url: null,
  analyzed_at: null,
  analyzed_from: null,
  artists_json: JSON.stringify(["Calibre"]),
  bpm: 174,
  bpm_source: null,
  duration_ms: 180000,
  enrichment_status: "done",
  features_json: JSON.stringify({ centroidHz: 1200 }),
  galaxy_name: null,
  galaxy_slug: null,
  in_release_id: null,
  isrc: null,
  key: null,
  key_source: null,
  label: null,
  log_id: "001.1.1A",
  note: null,
  observation_alignment_json: JSON.stringify({ words: [{ endMs: 500, startMs: 0, text: "hi" }] }),
  observation_audio_url: null,
  observation_duration_ms: null,
  observation_generated_at: null,
  popularity: null,
  preview_url: null,
  release_date: null,
  source_audio_failures: 0,
  source_audio_key: null,
  spotify_url: "https://open.spotify.com/track/abc",
  tiktok_url: null,
  title: "Mr Majestic",
  track_id: "track-calibre",
  updated_at: null,
  video_grain: null,
  video_model: null,
  video_model_reasoning: "high",
  video_palette: null,
  video_register: null,
  video_squared_at: null,
  video_url: null,
  video_vehicle: null,
  youtube_url: null,
};

// The mocked DB: the count query answers a scalar; every other query answers the one row.
function stubDb(): void {
  execute.mockImplementation(({ sql }: { sql: string }) =>
    sql.includes("count(*)")
      ? Promise.resolve({ rows: [{ total_count: 1 }] })
      : Promise.resolve({ rows: [FAT_ROW] }),
  );
}

// The SELECT (not the count) query's SQL text of the most recent listTracks call.
function lastSelectSql(): string {
  const call = execute.mock.calls
    .map(([arg]) => arg as { sql: string })
    .find((arg) => arg.sql.includes("join tracks") && !arg.sql.includes("count(*)"));

  return call?.sql ?? "";
}

// The three heavy columns, each named with the half of the tracks/findings pair it
// lives on: the spectral summary is the RECORDING's; the caption timings and the video's
// authoring metadata are the CERTIFICATION's.
const HEAVY_COLUMNS = [
  "tracks.features_json",
  "findings.observation_alignment_json",
  "findings.video_model_reasoning",
];

describe("listTracks lean list projection (Finding B4)", () => {
  beforeEach(() => {
    execute.mockReset();
    stubDb();
  });

  it("the FAT read SELECTs the three heavy columns and maps all three fields", async () => {
    const { tracks } = await listTracks({ limit: 10 });

    const sql = lastSelectSql();
    for (const column of HEAVY_COLUMNS) {
      expect(sql).toContain(column);
    }

    const item = tracks[0];
    expect(item?.features).toEqual({ centroidHz: 1200 });
    expect(item?.observationAlignment).toEqual({ words: [{ endMs: 500, startMs: 0, text: "hi" }] });
    expect(item?.videoModelReasoning).toBe("high");
  });

  it("the LEAN read drops the three heavy columns from the SELECT (derived SQL is well-formed)", async () => {
    await listTracks({ lean: true, limit: 10 });

    const sql = lastSelectSql();
    for (const column of HEAVY_COLUMNS) {
      expect(sql).not.toContain(column);
    }
    // The kept columns and the correlated subqueries survive — a sanity sample that the
    // comma-split derivation didn't mangle the SELECT.
    expect(sql).toContain("tracks.track_id");
    expect(sql).toContain("findings.observation_audio_url");
    expect(sql).toContain("as galaxy_name");
    expect(sql).toContain("as youtube_url");
    // No double comma / trailing comma from removing an interior column.
    expect(sql).not.toMatch(/,\s*,/);
    expect(sql).not.toMatch(/,\s*from findings/);
  });

  it("the LEAN read's mapped item omits the three heavy fields", async () => {
    const { tracks } = await listTracks({ lean: true, limit: 10 });
    const item = tracks[0] ?? {};

    expect("features" in item).toBe(false);
    expect("observationAlignment" in item).toBe(false);
    expect("videoModelReasoning" in item).toBe(false);
    // The rest of the DTO is intact — the lean read is a projection, not a different item.
    expect(tracks[0]?.trackId).toBe("track-calibre");
    expect(tracks[0]?.title).toBe("Mr Majestic");
    expect(tracks[0]?.bpm).toBe(174);
  });
});
