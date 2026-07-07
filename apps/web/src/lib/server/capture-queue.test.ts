import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

import { listTracks } from "./tracks";

// The full-song CAPTURE queue (RFC full-audio § Unit 1): `captureQueue=true` is a
// SEPARATE, status-aware queue — findings whose `capture_status` is pending ∪ failed ∪
// NULL — served NEWEST-FIRST so a fresh add jumps ahead of the whole-archive backfill.
// It must never leak a capture predicate into the enrich/embed queues (capture does NOT
// gate them). These are pure WHERE/ORDER clauses, so most are asserted on the SQL.

type StoredTrack = {
  added_at: string;
  capture_status: string | null;
  log_id: string | null;
  track_id: string;
};

// pending + failed + null are the queue; done + unmatched are terminal (never re-burned).
const archive: StoredTrack[] = [
  {
    added_at: "2026-06-01T00:00:00.000Z",
    capture_status: "pending",
    log_id: "001.1.1A",
    track_id: "t-old-pending",
  },
  {
    added_at: "2026-06-02T00:00:00.000Z",
    capture_status: "done",
    log_id: "002.1.1A",
    track_id: "t-done",
  },
  {
    added_at: "2026-06-03T00:00:00.000Z",
    capture_status: "failed",
    log_id: "003.1.1A",
    track_id: "t-failed",
  },
  {
    added_at: "2026-06-04T00:00:00.000Z",
    capture_status: "unmatched",
    log_id: "004.1.1A",
    track_id: "t-unmatched",
  },
  {
    added_at: "2026-06-05T00:00:00.000Z",
    capture_status: null,
    log_id: "005.1.1A",
    track_id: "t-null",
  },
  {
    added_at: "2026-06-06T00:00:00.000Z",
    capture_status: "pending",
    log_id: "006.1.1A",
    track_id: "t-new-pending",
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

// The JS mirror of the capture-queue SQL clause: pending ∪ failed ∪ NULL.
function matchesCaptureQueue(t: StoredTrack): boolean {
  return (
    t.capture_status === null || t.capture_status === "pending" || t.capture_status === "failed"
  );
}

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation(async (query: { args: unknown[]; sql: string }) => {
    const isCount = query.sql.includes("count(*)");
    const wantsCapture = query.sql.includes("capture_status");
    // Newest-first (desc) is what the capture cron passes; assert the ordering by mirroring it.
    const matched = archive
      .filter((t) => (wantsCapture ? matchesCaptureQueue(t) : true))
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

function lastListSql(): string {
  const listCall = execute.mock.calls.find(
    (c) => !(c[0] as { sql: string }).sql.includes("count(*)"),
  )?.[0] as { sql: string };

  return listCall.sql;
}

describe("listTracks captureQueue (the full-song capture queue)", () => {
  it("emits the status-aware clause (pending ∪ failed ∪ NULL), defensive NULL arm included", () => {
    // The clause is a fixed literal (no bound args), mirroring the context_status style.
    // The NULL arm is defensive even though the column is notNull-default.
    const clause = "(capture_status is null or capture_status in ('pending', 'failed'))";
    // Assert via a functional run below; here just confirm it reaches the SQL.
    return listTracks({ captureQueue: true, limit: 50, order: "desc" }).then(() => {
      expect(lastListSql()).toContain(clause);
    });
  });

  it("serves the queue NEWEST-FIRST so a fresh add jumps ahead of the backfill", async () => {
    const { tracks } = await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    const ids = tracks.map((t) => t.trackId);

    // Only pending/failed/null — terminal done/unmatched are excluded (never re-burned).
    expect(ids).toContain("t-new-pending");
    expect(ids).toContain("t-old-pending");
    expect(ids).toContain("t-failed");
    expect(ids).toContain("t-null");
    expect(ids).not.toContain("t-done");
    expect(ids).not.toContain("t-unmatched");

    // Newest-first: the just-added pending finding leads, the oldest trails.
    expect(ids).toEqual(["t-new-pending", "t-null", "t-failed", "t-old-pending"]);
    // And the ORDER BY is desc on both keys.
    expect(lastListSql()).toContain("order by added_at desc, track_id desc");
  });

  it("omits the capture clause entirely when captureQueue is not set", async () => {
    await listTracks({ limit: 50 });
    expect(lastListSql()).not.toContain("capture_status");
  });

  it("does NOT add a capture predicate to the ENRICH queue (capture never gates it)", async () => {
    await listTracks({ limit: 50, order: "asc", status: "queue" });
    const sql = lastListSql();
    expect(sql).toContain("enrichment_status");
    expect(sql).not.toContain("capture_status");
    expect(sql).not.toContain("source_audio");
  });

  it("does NOT add a capture predicate to the EMBED queue (capture never gates it)", async () => {
    await listTracks({ hasEmbedding: false, limit: 50, order: "asc" });
    const sql = lastListSql();
    expect(sql).toContain("embedding_json is null");
    expect(sql).not.toContain("capture_status");
  });
});
