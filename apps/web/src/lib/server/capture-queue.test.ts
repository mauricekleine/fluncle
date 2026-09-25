import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

import {
  CAPTURE_FAILED_COOLDOWN_MS,
  CAPTURE_MAX_FAILURES,
  groupArtistYoutubeChannelIds,
  listTracks,
} from "./tracks";

type StoredTrack = {
  added_at: string;
  capture_status: string | null;
  log_id: string | null;
  source_audio_attempted_at: string | null;
  source_audio_failures: number;
  track_id: string;
};

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const TWO_HOURS_AGO = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
const TEN_MIN_AGO = new Date(NOW - 10 * 60 * 1000).toISOString();

const archive: StoredTrack[] = [
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

const ARTIST_YOUTUBE_SOCIALS: Record<string, string[]> = {
  "t-failed-ready": ["https://www.youtube.com/channel/UC_BBB"],
  "t-new-pending": [
    "https://www.youtube.com/channel/UC_AAA",
    "https://www.youtube.com/channel/UC_AAA",
    "https://www.youtube.com/@handle-only",
  ],
};

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
    video_grain: null,
    video_model: null,
    video_model_reasoning: null,
    video_palette: null,
    video_register: null,
    video_url: null,
    video_vehicle: null,
    youtube_url: null,
  };
}

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
    if (query.sql.includes("artist_socials")) {
      const requestedIds = query.args as string[];
      const rows = requestedIds.flatMap((trackId) =>
        (ARTIST_YOUTUBE_SOCIALS[trackId] ?? []).map((url) => ({ track_id: trackId, url })),
      );

      return { rows };
    }

    const isCount = query.sql.includes("count(*)");
    const wantsCapture = query.sql.includes("capture_status");

    const cooldownCutoffMs = Date.parse(String(query.args[0]));
    const matched = archive
      .filter((t) => (wantsCapture ? matchesCaptureQueue(t, cooldownCutoffMs) : true))

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
  const listCall = execute.mock.calls.find((c) =>
    (c[0] as { sql: string }).sql.includes("from findings join tracks"),
  )?.[0] as { sql: string };

  return listCall.sql;
}

describe("listTracks captureQueue (the full-song capture queue)", () => {
  it("emits the status-aware + backoff clause and BINDS the cooldown cutoff (never interpolated)", async () => {
    await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    const listCall = execute.mock.calls.find((c) =>
      (c[0] as { sql: string }).sql.includes("from findings join tracks"),
    )?.[0] as { args: unknown[]; sql: string };

    expect(listCall.sql).toContain("findings.log_id is not null");
    expect(listCall.sql).toContain(
      "tracks.capture_status is null or tracks.capture_status = 'pending'",
    );
    expect(listCall.sql).toContain(`tracks.source_audio_failures < ${CAPTURE_MAX_FAILURES}`);
    expect(listCall.sql).toContain(
      "tracks.source_audio_attempted_at is null or tracks.source_audio_attempted_at < ?",
    );

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

    expect(ids).toEqual(["t-new-pending", "t-null", "t-failed-ready"]);
    expect(lastListSql()).toContain("order by findings.added_at desc, findings.track_id desc");
  });

  it("EXCLUDES terminal, cooling, capped, and coordinate-less findings", async () => {
    const { tracks } = await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    const ids = tracks.map((t) => t.trackId);

    expect(ids).not.toContain("t-done");
    expect(ids).not.toContain("t-unmatched");
    expect(ids).not.toContain("t-failed-cooling");
    expect(ids).not.toContain("t-failed-capped");
    expect(ids).not.toContain("t-no-logid");
  });

  it("re-includes a failed row once its attempt is past the cooldown", async () => {
    const before = await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    expect(before.tracks.map((t) => t.trackId)).not.toContain("t-failed-cooling");

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

    expect(sql).not.toContain("capture_status");
  });

  it("does NOT add a capture predicate to the EMBED queue (capture never gates it)", async () => {
    await listTracks({ hasEmbedding: false, limit: 50, order: "asc" });
    const sql = lastListSql();
    expect(sql).toContain("has_embedding = 0");
    expect(sql).not.toContain("capture_status");
  });
});

describe("listTracks captureQueue — artistYoutubeChannelIds", () => {
  it("populates artistYoutubeChannelIds (deduped, /channel/UC… only) on the capture queue", async () => {
    const { tracks } = await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    const byId = new Map(tracks.map((t) => [t.trackId, t]));

    expect(byId.get("t-new-pending")?.artistYoutubeChannelIds).toEqual(["UC_AAA"]);
    expect(byId.get("t-failed-ready")?.artistYoutubeChannelIds).toEqual(["UC_BBB"]);

    expect(byId.get("t-null")?.artistYoutubeChannelIds).toBeUndefined();
  });

  it("binds the track ids into the artist_socials read (never interpolated)", async () => {
    await listTracks({ captureQueue: true, limit: 50, order: "desc" });
    const socialsCall = execute.mock.calls.find((c) =>
      (c[0] as { sql: string }).sql.includes("artist_socials"),
    )?.[0] as { args: unknown[]; sql: string };

    expect(socialsCall.sql).toContain("artist_socials.platform = 'youtube'");

    expect(socialsCall.args).toEqual(["t-new-pending", "t-null", "t-failed-ready"]);
    expect(socialsCall.sql).toContain("in (?, ?, ?)");
    for (const id of socialsCall.args) {
      expect(socialsCall.sql).not.toContain(String(id));
    }
  });

  it("does NOT read artist_socials for a non-capture list (capture-queue-only signal)", async () => {
    await listTracks({ limit: 50 });
    const firedArtistSocials = execute.mock.calls.some((c) =>
      (c[0] as { sql: string }).sql.includes("artist_socials"),
    );

    expect(firedArtistSocials).toBe(false);
  });
});

describe("groupArtistYoutubeChannelIds", () => {
  it("groups by track_id, dedupes, and ignores non-/channel URLs", () => {
    const grouped = groupArtistYoutubeChannelIds([
      { track_id: "a", url: "https://www.youtube.com/channel/UC_1" },
      { track_id: "a", url: "https://www.youtube.com/channel/UC_1" },
      { track_id: "a", url: "https://www.youtube.com/channel/UC_2" },
      { track_id: "a", url: "https://www.youtube.com/@handle" },
      { track_id: "b", url: "https://www.youtube.com/user/name" },
    ]);

    expect(grouped.get("a")).toEqual(["UC_1", "UC_2"]);
    expect(grouped.has("b")).toBe(false);
  });

  it("returns an empty map for no rows", () => {
    expect(groupArtistYoutubeChannelIds([]).size).toBe(0);
  });
});
