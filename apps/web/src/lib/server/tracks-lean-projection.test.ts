import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

import { listTracks } from "./tracks";

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

function stubDb(): void {
  execute.mockImplementation(({ sql }: { sql: string }) =>
    sql.includes("count(*)")
      ? Promise.resolve({ rows: [{ total_count: 1 }] })
      : Promise.resolve({ rows: [FAT_ROW] }),
  );
}

function lastSelectSql(): string {
  const call = execute.mock.calls
    .map(([arg]) => arg as { sql: string })
    .find((arg) => arg.sql.includes("join tracks") && !arg.sql.includes("count(*)"));

  return call?.sql ?? "";
}

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

    expect(sql).not.toContain("as album_artwork_url_template");
    expect(sql).not.toContain("as album_artwork_width");
    expect(sql).not.toContain("as album_artwork_height");

    expect(sql).toContain("tracks.track_id");
    expect(sql).toContain("findings.observation_audio_url");
    expect(sql).toContain("as galaxy_name");
    expect(sql).toContain("as youtube_url");
    expect(sql).toContain("as album_image_key");

    expect(sql).not.toMatch(/,\s*,/);
    expect(sql).not.toMatch(/,\s*from findings/);
  });

  it("the LEAN read's mapped item omits the three heavy fields", async () => {
    const { tracks } = await listTracks({ lean: true, limit: 10 });
    const item = tracks[0] ?? {};

    expect("features" in item).toBe(false);
    expect("observationAlignment" in item).toBe(false);
    expect("videoModelReasoning" in item).toBe(false);

    expect(tracks[0]?.trackId).toBe("track-calibre");
    expect(tracks[0]?.title).toBe("Mr Majestic");
    expect(tracks[0]?.bpm).toBe(174);
  });
});

const BOARD_DROPPED_SUBQUERY_ALIASES = [
  "as galaxy_name",
  "as galaxy_slug",
  "as album_slug",
  "as album_artwork_url_template",
  "as album_artwork_width",
  "as album_artwork_height",
  "as label_slug",
  "as youtube_url",
];

describe("listTracks board list projection (renders + findings efficiency batch)", () => {
  beforeEach(() => {
    execute.mockReset();
    stubDb();
  });

  it("the BOARD read drops the heavy columns AND the graph/discovery subqueries, keeps the cover master + tiktok (derived SQL well-formed)", async () => {
    await listTracks({ board: true, limit: 10 });

    const sql = lastSelectSql();

    for (const column of HEAVY_COLUMNS) {
      expect(sql).not.toContain(column);
    }
    for (const alias of BOARD_DROPPED_SUBQUERY_ALIASES) {
      expect(sql).not.toContain(alias);
    }

    expect(sql).toContain("as album_image_key");
    expect(sql).toContain("as album_image_state");
    expect(sql).toContain("as tiktok_url");

    expect(sql).toContain("tracks.track_id");
    expect(sql).toContain("findings.observation_audio_url");

    expect(sql).not.toMatch(/,\s*,/);
    expect(sql).not.toMatch(/,\s*from findings/);
  });

  it("countTotal:false skips the count(*) companion query", async () => {
    await listTracks({ board: true, countTotal: false, limit: 10 });

    const ranCount = execute.mock.calls
      .map(([arg]) => arg as { sql: string })
      .some((arg) => arg.sql.includes("count(*)"));
    expect(ranCount).toBe(false);
  });

  it("the BOARD read's mapped item omits the heavy + graph/discovery fields, keeps the core DTO", async () => {
    const { tracks } = await listTracks({ board: true, limit: 10 });
    const item = tracks[0] ?? {};

    for (const field of [
      "features",
      "observationAlignment",
      "videoModelReasoning",
      "galaxy",
      "albumSlug",
      "artworkMaxUrl",
      "labelSlug",
      "youtubeUrl",
    ]) {
      expect(field in item).toBe(false);
    }

    expect(tracks[0]?.trackId).toBe("track-calibre");
    expect(tracks[0]?.title).toBe("Mr Majestic");
    expect(tracks[0]?.enrichmentStatus).toBe("done");
    expect(tracks[0]?.tiktokUrl).toBeUndefined();
  });
});

const GRAPH_DROPPED_SUBQUERY_ALIASES = [
  "as album_slug",
  "as label_slug",
  "as youtube_url",
  "as tiktok_url",

  "as album_artwork_url_template",
  "as album_artwork_width",
  "as album_artwork_height",
];

describe("getFindingsByArtist graph list projection", () => {
  beforeEach(() => {
    execute.mockReset();
    stubDb();
  });

  it("drops the heavy + graph-link + post subqueries, KEEPS galaxy + the cover master", async () => {
    const { getFindingsByArtist } = await import("./tracks");
    await getFindingsByArtist("artist-1", "Calibre");

    const sql = lastSelectSql();
    for (const column of HEAVY_COLUMNS) {
      expect(sql).not.toContain(column);
    }
    for (const alias of GRAPH_DROPPED_SUBQUERY_ALIASES) {
      expect(sql).not.toContain(alias);
    }

    expect(sql).toContain("as galaxy_name");
    expect(sql).toContain("as galaxy_slug");
    expect(sql).toContain("as album_image_key");

    expect(sql).toContain("findings.log_id");
    expect(sql).toContain("tracks.title");
    expect(sql).toContain("tracks.release_date");
    expect(sql).not.toMatch(/,\s*,/);
    expect(sql).not.toMatch(/,\s*from findings/);
  });

  it("the mapped graph item keeps galaxy, drops the graph-link + post fields", async () => {
    execute.mockImplementation(({ sql }: { sql: string }) =>
      sql.includes("count(*)")
        ? Promise.resolve({ rows: [{ total_count: 1 }] })
        : Promise.resolve({
            rows: [{ ...FAT_ROW, galaxy_name: "Hospital Sound", galaxy_slug: "hospital-sound" }],
          }),
    );

    const { getFindingsByArtist } = await import("./tracks");
    const [item] = await getFindingsByArtist("artist-1", "Calibre");

    expect(item?.galaxy).toEqual({ name: "Hospital Sound", slug: "hospital-sound" });
    for (const field of ["albumSlug", "labelSlug", "tiktokUrl", "youtubeUrl", "features"]) {
      expect(field in (item ?? {})).toBe(false);
    }

    expect(item?.trackId).toBe("track-calibre");
    expect(item?.title).toBe("Mr Majestic");
    expect(item?.logId).toBe("001.1.1A");
  });
});

describe("listLogIndexEntries (the /log text index read)", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("selects only the five text-row columns — no cover master, no correlated subqueries", async () => {
    execute.mockResolvedValue({ rows: [] });

    const { listLogIndexEntries } = await import("./tracks");
    await listLogIndexEntries(500);

    const sql = (execute.mock.calls[0]?.[0] as { sql: string } | undefined)?.sql ?? "";
    for (const column of [
      "findings.log_id",
      "tracks.track_id",
      "tracks.title",
      "tracks.artists_json",
      "findings.added_at",
    ]) {
      expect(sql).toContain(column);
    }

    expect(sql).not.toContain("album_image_key");
    expect(sql).not.toContain("(select");
    expect(sql).toContain("where findings.log_id is not null");
  });

  it("maps a row to the lean text entry", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          added_at: "2026-06-01T00:00:00.000Z",
          artists_json: JSON.stringify(["Calibre"]),
          log_id: "001.1.1A",
          title: "Mr Majestic",
          track_id: "track-calibre",
        },
      ],
    });

    const { listLogIndexEntries } = await import("./tracks");
    const [entry] = await listLogIndexEntries();

    expect(entry).toEqual({
      addedAt: "2026-06-01T00:00:00.000Z",
      artists: ["Calibre"],
      logId: "001.1.1A",
      title: "Mr Majestic",
      trackId: "track-calibre",
    });
  });
});
