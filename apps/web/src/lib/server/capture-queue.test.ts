import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

import { CAPTURE_FAILED_COOLDOWN_MS, CAPTURE_MAX_FAILURES, listTracks } from "./tracks";

// The full-song CAPTURE queue (RFC full-audio § Unit 1): `captureQueue=true` is a
// SEPARATE, status-aware queue served NEWEST-FIRST so a fresh add jumps ahead of the
// backfill. `pending`/NULL are always eligible; a `failed` row BACKS OFF (re-picked only
// past the cooldown + below the failure cap); `done`/`unmatched` are terminal; a
// coordinate-less row is excluded. It must never leak a capture predicate into the
// enrich/embed queues (capture does NOT gate them).

type StoredTrack = {
  added_at: string;
  capture_status: string | null;
  log_id: string | null;
  source_audio_attempted_at: string | null;
  source_audio_failures: number;
  track_id: string;
};

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const TWO_HOURS_AGO = new Date(NOW - 2 * 60 * 60 * 1000).toISOString(); // past the 60m cooldown
const TEN_MIN_AGO = new Date(NOW - 10 * 60 * 1000).toISOString(); // within the 60m cooldown

const archive: StoredTrack[] = [
  // In the queue:
  {
    added_at: "2026-06-06T00:00:00.000Z",
    capture_status: "pending",
    log_id: "006.1.1A",
    source_audio_attempted_at: null,
    source_audio_failures: 0,
    track_id: "t-new-pending",
  },
  {
    added_at: "2026-06-05T00:00:00.000Z",
    capture_status: null,
    log_id: "005.1.1A",
    source_audio_attempted_at: null,
    source_audio_failures: 0,
    track_id: "t-null",
  },
  {
    added_at: "2026-06-04T00:00:00.000Z",
    capture_status: "failed",
    log_id: "004.1.1A",
    source_audio_attempted_at: TWO_HOURS_AGO,
    source_audio_failures: 2,
    track_id: "t-failed-ready",
  },
  // Excluded:
  {
    added_at: "2026-06-03T00:00:00.000Z",
    capture_status: "failed",
    log_id: "003.1.1A",
    source_audio_attempted_at: TEN_MIN_AGO,
    source_audio_failures: 2,
    track_id: "t-failed-cooling",
  },
  {
    added_at: "2026-06-02T00:00:00.000Z",
    capture_status: "failed",
    log_id: "002.1.1A",
    source_audio_attempted_at: TWO_HOURS_AGO,
    source_audio_failures: CAPTURE_MAX_FAILURES,
    track_id: "t-failed-capped",
  },
  {
    added_at: "2026-06-01T00:00:00.000Z",
    capture_status: "done",
    log_id: "001.1.1A",
    source_audio_attempted_at: null,
    source_audio_failures: 0,
    track_id: "t-done",
  },
  {
    added_at: "2026-05-31T00:00:00.000Z",
    capture_status: "unmatched",
    log_id: "000.1.1A",
    source_audio_attempted_at: null,
    source_audio_failures: 0,
    track_id: "t-unmatched",
  },
  {
    added_at: "2026-05-30T00:00:00.000Z",
    capture_status: "pending",
    log_id: null,
    source_audio_attempted_at: null,
    source_audio_failures: 0,
    track_id: "t-no-logid",
  },
];

function fullRow(stored: StoredTrack) {
  return {
    ...stored,
    added_to_spotify: 0,
    album: null,
    album_image_url: null,
    artists_json: JSON.stringify(["Artist"]),
    bpm: null,
    duration_ms: 300000,
    features_json: null,
    isrc: null,
    key: null,
    label: null,
    note: null,
    observation_audio_url: null,
    observation_duration_ms: null,
    observation_generated_at: null,
    popularity: null,
    posted_to_telegram: 0,
    preview_url: null,
    release_date: null,
    spotify_url: `https://open.spotify.com/track/${stored.track_id}`,
    tiktok_url: null,
    title: "Title",
    vibe_x: null,
    vibe_y: null,
    video_grain: null,
    video_model: null,
    video_model_reasoning: null,
    video_register: null,
    video_url: null,
    video_vehicle: null,
    youtube_url: null,
  };
}

// The JS mirror of the capture-queue SQL clause: pending/NULL always; failed backs off
// (below the cap AND past the cooldown); log_id required; done/unmatched excluded.
function matchesCaptureQueue(t: StoredTrack, cooldownCutoffMs: number): boolean {
  if (t.log_id === null) {
    return false;
  }
  if (t.capture_status === null || t.capture_status === "pending") {
    return true;
  }
  if (t.capture_status === "failed") {
    return (
      t.source_audio_failures < CAPTURE_MAX_FAILURES &&
      (t.source_audio_attempted_at === null ||
        Date.parse(t.source_audio_attempted_at) < cooldownCutoffMs)
    );
  }
  return false;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  execute.mockReset();
  execute.mockImplementation(async (query: { args: unknown[]; sql: string }) => {
    const isCount = query.sql.includes("count(*)");
    const wantsCapture = query.sql.includes("capture_status");
    // listTracks binds the capture cooldown cutoff as the first filter arg.
    const cooldownCutoffMs = Date.parse(String(query.args[0]));
    const matched = archive
      .filter((t) => (wantsCapture ? matchesCaptureQueue(t, cooldownCutoffMs) : true))
      // Newest-first (desc), tie-break track_id desc — the order the capture cron passes.
      .sort((a, b) =>
        a.added_at === b.added_at
          ? b.track_id.localeCompare(a.track_id)
          : b.added_at.localeCompare(a.added_at),
      );

    if (isCount) {
      return { rows: [{ total_count: matched.length }] };
    }

    const limit = Number(query.args.at(-1));
    return { rows: matched.slice(0, limit).map(fullRow) };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function lastListSql(): string {
  const listCall = execute.mock.calls.find(
    (c) => !(c[0] as { sql: string }).sql.includes("count(*)"),
  )?.[0] as { sql: string };

  return listCall.sql;
}

describe("listTracks captureQueue (the full-song capture queue)", () => {
  it("emits the status-aware + backoff clause and BINDS the cooldown cutoff (never interpolated)", async () => {
    await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    const listCall = execute.mock.calls.find(
      (c) => !(c[0] as { sql: string }).sql.includes("count(*)"),
    )?.[0] as { args: unknown[]; sql: string };

    // pending/NULL always eligible; failed gated on the cap + the cooldown; coord required.
    expect(listCall.sql).toContain("log_id is not null");
    expect(listCall.sql).toContain("capture_status is null or capture_status = 'pending'");
    expect(listCall.sql).toContain(`source_audio_failures < ${CAPTURE_MAX_FAILURES}`);
    expect(listCall.sql).toContain(
      "source_audio_attempted_at is null or source_audio_attempted_at < ?",
    );
    // The cutoff is BOUND (now − cooldown), never string-concatenated into the SQL.
    const expectedCutoff = new Date(NOW - CAPTURE_FAILED_COOLDOWN_MS).toISOString();
    expect(listCall.args[0]).toBe(expectedCutoff);
    expect(listCall.sql).not.toContain(expectedCutoff);
  });

  it("serves pending/NULL + a past-cooldown failed row, NEWEST-FIRST", async () => {
    const { tracks } = await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    const ids = tracks.map((t) => t.trackId);

    expect(ids).toContain("t-new-pending");
    expect(ids).toContain("t-null");
    expect(ids).toContain("t-failed-ready");
    // Newest-first: the just-added pending finding leads.
    expect(ids).toEqual(["t-new-pending", "t-null", "t-failed-ready"]);
    expect(lastListSql()).toContain("order by added_at desc, track_id desc");
  });

  it("EXCLUDES terminal, cooling, capped, and coordinate-less findings", async () => {
    const { tracks } = await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    const ids = tracks.map((t) => t.trackId);

    expect(ids).not.toContain("t-done"); // terminal
    expect(ids).not.toContain("t-unmatched"); // terminal
    expect(ids).not.toContain("t-failed-cooling"); // within the cooldown
    expect(ids).not.toContain("t-failed-capped"); // at the failure cap
    expect(ids).not.toContain("t-no-logid"); // coordinate-less
  });

  it("re-includes a failed row once its attempt is past the cooldown", async () => {
    // Before cooldown: excluded.
    const before = await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    expect(before.tracks.map((t) => t.trackId)).not.toContain("t-failed-cooling");

    // Advance past the cooldown → the same row is now eligible.
    vi.setSystemTime(NOW + CAPTURE_FAILED_COOLDOWN_MS);
    const after = await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    expect(after.tracks.map((t) => t.trackId)).toContain("t-failed-cooling");
  });

  it("omits the capture clause entirely when captureQueue is not set", async () => {
    await listTracks({ limit: 50 });
    expect(lastListSql()).not.toContain("capture_status");
  });

  it("does NOT add a capture predicate to the ENRICH queue (capture never gates it)", async () => {
    await listTracks({ limit: 50, order: "asc", status: "queue" });
    const sql = lastListSql();
    expect(sql).toContain("enrichment_status");
    // `capture_status` is unique to the capture WHERE clause (it is never in TRACK_SELECT,
    // unlike `source_audio_failures` which is now a surfaced DTO column), so its absence
    // proves the enrich queue carries no capture predicate.
    expect(sql).not.toContain("capture_status");
  });

  it("does NOT add a capture predicate to the EMBED queue (capture never gates it)", async () => {
    await listTracks({ hasEmbedding: false, limit: 50, order: "asc" });
    const sql = lastListSql();
    expect(sql).toContain("embedding_json is null");
    expect(sql).not.toContain("capture_status");
  });
});
