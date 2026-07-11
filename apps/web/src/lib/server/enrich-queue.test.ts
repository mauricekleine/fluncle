import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

import { ENRICH_STALE_PROCESSING_MS, listTracks } from "./tracks";

type StoredTrack = {
  added_at: string;
  enrichment_status: string;
  log_id: string | null;
  track_id: string;
  updated_at: string | null;
};

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

// A tiny archive spanning every queue case: pending, failed, done (excluded),
// fresh processing (excluded — still in-flight), STALE processing (included —
// the box-rebooted case), and a null-updated_at processing row (included —
// predates the column, so we can't prove it's fresh).
const archive: StoredTrack[] = [
  {
    added_at: "2026-06-01T00:00:00.000Z",
    enrichment_status: "pending",
    log_id: "001.1.1A",
    track_id: "t-pending",
    updated_at: null,
  },
  {
    added_at: "2026-06-02T00:00:00.000Z",
    enrichment_status: "failed",
    log_id: "002.1.1A",
    track_id: "t-failed",
    updated_at: "2026-06-02T00:10:00.000Z",
  },
  {
    added_at: "2026-06-03T00:00:00.000Z",
    enrichment_status: "done",
    log_id: "003.1.1A",
    track_id: "t-done",
    updated_at: "2026-06-03T00:10:00.000Z",
  },
  {
    added_at: "2026-06-04T00:00:00.000Z",
    enrichment_status: "processing",
    log_id: "004.1.1A",
    // Bumped one minute ago — well inside the staleness window, still in-flight.
    track_id: "t-processing-fresh",
    updated_at: new Date(NOW - 60 * 1000).toISOString(),
  },
  {
    added_at: "2026-06-05T00:00:00.000Z",
    enrichment_status: "processing",
    // Bumped two hours ago — past the threshold, so presumed stuck.
    log_id: "005.1.1A",
    track_id: "t-processing-stale",
    updated_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    added_at: "2026-06-06T00:00:00.000Z",
    enrichment_status: "processing",
    // No updated_at (predates the column) — treated as stale.
    log_id: "006.1.1A",
    track_id: "t-processing-null",
    updated_at: null,
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
    duration_ms: 180000,
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
    video_grain: null,
    video_model: null,
    video_model_reasoning: null,
    video_register: null,
    video_url: null,
    video_vehicle: null,
    youtube_url: null,
  };
}

// The JS mirror of the "queue" SQL clause: pending ∪ failed ∪ stale processing.
function matchesQueue(t: StoredTrack, staleCutoffMs: number): boolean {
  if (t.enrichment_status === "pending" || t.enrichment_status === "failed") {
    return true;
  }

  if (t.enrichment_status === "processing") {
    return t.updated_at === null || Date.parse(t.updated_at) < staleCutoffMs;
  }

  return false;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  execute.mockReset();
  execute.mockImplementation(async (query: { args: unknown[]; sql: string }) => {
    // The count query selects count(*); the list query selects the columns.
    const isCount = query.sql.includes("count(*)");
    // listTracks binds the queue's stale cutoff as the first filter arg.
    const staleCutoff = Date.parse(String(query.args[0]));
    const matched = archive
      .filter((t) => matchesQueue(t, staleCutoff))
      .sort((a, b) =>
        a.added_at === b.added_at
          ? a.track_id.localeCompare(b.track_id)
          : a.added_at.localeCompare(b.added_at),
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

describe('listTracks status: "queue" (the self-healing filter)', () => {
  it("binds the stale-processing cutoff as a parameter, never interpolated", async () => {
    await listTracks({ limit: 50, order: "asc", status: "queue" });

    const listCall = execute.mock.calls.find(
      (c) => !(c[0] as { sql: string }).sql.includes("count(*)"),
    )?.[0] as { args: unknown[]; sql: string };

    expect(listCall.sql).toContain("enrichment_status");
    expect(listCall.sql).toContain("processing");
    // The cutoff is bound, not concatenated.
    const expectedCutoff = new Date(NOW - ENRICH_STALE_PROCESSING_MS).toISOString();
    expect(listCall.args[0]).toBe(expectedCutoff);
    expect(listCall.sql).not.toContain(expectedCutoff);
  });

  it("includes pending, failed, AND stale processing — but not done or fresh processing", async () => {
    const { tracks } = await listTracks({ limit: 50, order: "asc", status: "queue" });
    const ids = tracks.map((t) => t.trackId);

    // The whole point of the fix: a box-rebooted `processing` track is re-picked.
    expect(ids).toContain("t-processing-stale");
    expect(ids).toContain("t-processing-null");
    expect(ids).toContain("t-pending");
    expect(ids).toContain("t-failed");

    // A done track and a still-in-flight (fresh) processing track are NOT in the queue.
    expect(ids).not.toContain("t-done");
    expect(ids).not.toContain("t-processing-fresh");
  });

  it("orders oldest-first (asc) so the backlog drains in found order", async () => {
    const { tracks } = await listTracks({ limit: 50, order: "asc", status: "queue" });

    expect(tracks.map((t) => t.trackId)).toEqual([
      "t-pending",
      "t-failed",
      "t-processing-stale",
      "t-processing-null",
    ]);
  });
});

// The observation-pipeline queues (Build order #3): hasContext / hasObservation
// gate which findings the context + observation crons pull. They are pure WHERE
// clauses, so assert the generated SQL (the archive mock above ignores them).
describe("listTracks hasContext / hasObservation filters (the observation queues)", () => {
  function lastListSql(): string {
    const listCall = execute.mock.calls.find(
      (c) => !(c[0] as { sql: string }).sql.includes("count(*)"),
    )?.[0] as { sql: string };

    return listCall.sql;
  }

  it("the context queue (hasContext=false) is status-aware: no note + pending/failed/NULL, not empty", async () => {
    await listTracks({ hasContext: false, limit: 50 });
    const sql = lastListSql();
    // No note yet AND never-attempted (NULL, predating the column) ∪ pending ∪ failed
    // — a confirmed `empty` find is excluded so the cron does not re-burn it every tick.
    expect(sql).toContain(
      "findings.context_note is null and (findings.context_status is null or findings.context_status in ('pending', 'failed'))",
    );
    expect(sql).not.toContain("'empty'");
  });

  it("hasContext=false with retryEmptyContext widens the queue to also re-pick `empty`", async () => {
    await listTracks({ hasContext: false, limit: 50, retryEmptyContext: true });
    const sql = lastListSql();
    expect(sql).toContain(
      "findings.context_note is null and (findings.context_status is null or findings.context_status in ('pending', 'failed', 'empty'))",
    );
  });

  it("retryEmptyContext has no effect without hasContext=false", async () => {
    await listTracks({ limit: 50, retryEmptyContext: true });
    expect(lastListSql()).not.toContain("context_status");
  });

  it("hasContext=true filters `context_note is not null`", async () => {
    await listTracks({ hasContext: true, limit: 50 });
    expect(lastListSql()).toContain("context_note is not null");
  });

  it("the observation queue (hasContext=true AND hasObservation=false) ANDs both clauses", async () => {
    await listTracks({ hasContext: true, hasObservation: false, limit: 50 });
    const sql = lastListSql();
    expect(sql).toContain("context_note is not null");
    expect(sql).toContain("observation_audio_url is null");
  });

  it("hasObservation=true filters `observation_audio_url is not null`", async () => {
    await listTracks({ hasObservation: true, limit: 50 });
    expect(lastListSql()).toContain("observation_audio_url is not null");
  });

  it("omits both clauses when neither filter is passed", async () => {
    await listTracks({ limit: 50 });
    const sql = lastListSql();
    expect(sql).not.toContain("context_note");
    expect(sql).not.toContain("observation_audio_url is");
  });
});
