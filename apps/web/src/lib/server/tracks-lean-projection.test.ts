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
    // The render-only artworkMax subqueries drop from the feed too (Finding 4b): no web/feed
    // surface renders `artworkMaxUrl` — the video pipeline reads it off the FAT single-track
    // read, never the feed — so the lean SELECT stops running them.
    expect(sql).not.toContain("as album_artwork_url_template");
    expect(sql).not.toContain("as album_artwork_width");
    expect(sql).not.toContain("as album_artwork_height");
    // The kept columns and the surviving correlated subqueries — a sanity sample that the
    // comma-split derivation didn't mangle the SELECT (galaxy + the youtube post stay on lean;
    // only the board/graph reads drop those).
    expect(sql).toContain("tracks.track_id");
    expect(sql).toContain("findings.observation_audio_url");
    expect(sql).toContain("as galaxy_name");
    expect(sql).toContain("as youtube_url");
    expect(sql).toContain("as album_image_key");
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

// The graph/discovery correlated subqueries the BOARD projection drops on top of the lean
// three — each named by the `as <alias>` output the derivation filters on.
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
    // Everything the lean read drops, plus the graph/discovery correlated subqueries.
    for (const column of HEAVY_COLUMNS) {
      expect(sql).not.toContain(column);
    }
    for (const alias of BOARD_DROPPED_SUBQUERY_ALIASES) {
      expect(sql).not.toContain(alias);
    }
    // The two subquery families the boards DO render survive: the album cover master (the
    // row cover) and the tiktok url (the clip preview's "Watch on TikTok").
    expect(sql).toContain("as album_image_key");
    expect(sql).toContain("as album_image_state");
    expect(sql).toContain("as tiktok_url");
    // Direct columns are untouched.
    expect(sql).toContain("tracks.track_id");
    expect(sql).toContain("findings.observation_audio_url");
    // The comma-split derivation left no double / trailing comma.
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
    // A board item is still a finding — the identity + ledger fields the boards render survive.
    expect(tracks[0]?.trackId).toBe("track-calibre");
    expect(tracks[0]?.title).toBe("Mr Majestic");
    expect(tracks[0]?.enrichmentStatus).toBe("done");
    expect(tracks[0]?.tiktokUrl).toBeUndefined();
  });
});

// The graph reads (`getFindingsBy*`, backing the /artist · /label · /album pages + oembed + the
// hover card + the MCP get_artist/get_label tools + the admin bio-describe) take the GRAPH
// projection: the lean drops PLUS the album/label graph-link slugs + the youtube/tiktok post
// subqueries, but KEEPING galaxy (the MCP tools report it) and the album cover master.
const GRAPH_DROPPED_SUBQUERY_ALIASES = [
  "as album_slug",
  "as label_slug",
  "as youtube_url",
  "as tiktok_url",
  // The render-only artworkMax subqueries drop here too (already gone from the lean base).
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
    // Galaxy survives (the MCP get_artist/get_label tools read it), and so does the cover master
    // (the grid cover) — the two subquery families the graph reads genuinely render.
    expect(sql).toContain("as galaxy_name");
    expect(sql).toContain("as galaxy_slug");
    expect(sql).toContain("as album_image_key");
    // The direct columns the grid + its JSON-LD render survive.
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

    // Galaxy is kept (the MCP tools' `compactFinding` reads `galaxy?.name`).
    expect(item?.galaxy).toEqual({ name: "Hospital Sound", slug: "hospital-sound" });
    for (const field of ["albumSlug", "labelSlug", "tiktokUrl", "youtubeUrl", "features"]) {
      expect(field in (item ?? {})).toBe(false);
    }
    // A graph item is still a finding — the grid + JSON-LD fields survive.
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
    // No cover master, and no correlated subquery of any kind — the text list renders none.
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
