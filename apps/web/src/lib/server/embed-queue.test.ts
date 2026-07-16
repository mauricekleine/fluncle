import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

import { listTracks } from "./tracks";

// The MuQ embed worklist (RFC full-audio § Unit 3): `hasEmbedding=false` lists findings
// still needing an embedding — but ONLY the CAPTURED full songs, never a preview or the
// unmatched tail. So the queue is `embedding_blob IS NULL AND source_audio_key IS NOT NULL`:
// a keyless finding is excluded (there is no captured song to embed from); a keyed but
// still-unembedded one is in. `hasEmbedding=true` stays a pure presence check (no key gate).

type StoredTrack = {
  added_at: string;
  embedding_blob: string | null;
  source_audio_key: string | null;
  track_id: string;
};

const archive: StoredTrack[] = [
  // IN the queue: captured (has a source key) but not yet embedded.
  {
    added_at: "2026-06-03T00:00:00.000Z",
    embedding_blob: null,
    source_audio_key: "003.1.1A/abc.m4a",
    track_id: "t-keyed-unembedded",
  },
  // EXCLUDED: no captured song → nothing to embed from.
  {
    added_at: "2026-06-02T00:00:00.000Z",
    embedding_blob: null,
    source_audio_key: null,
    track_id: "t-keyless",
  },
  // EXCLUDED: already carries a vector.
  {
    added_at: "2026-06-01T00:00:00.000Z",
    embedding_blob: "[0.1]",
    source_audio_key: "001.1.1A/def.m4a",
    track_id: "t-embedded",
  },
];

// A complete-enough TrackRow for toTrackListItem (listTracks does no schema validation;
// the DTO shape is validated at the oRPC boundary, not here).
function fullRow(stored: StoredTrack) {
  return {
    ...stored,
    added_to_spotify: 0,
    album: null,
    album_image_url: null,
    artists_json: JSON.stringify(["Artist"]),
    bpm: null,
    duration_ms: 300000,
    enrichment_status: "done",
    features_json: null,
    in_release_id: null,
    isrc: null,
    key: null,
    label: null,
    log_id: stored.track_id,
    note: null,
    observation_alignment_json: null,
    observation_audio_url: null,
    observation_duration_ms: null,
    observation_generated_at: null,
    popularity: null,
    posted_to_telegram: 0,
    preview_url: null,
    release_date: null,
    source_audio_failures: 0,
    spotify_url: `https://open.spotify.com/track/${stored.track_id}`,
    tiktok_url: null,
    title: "Title",
    updated_at: null,
    video_grain: null,
    video_model: null,
    video_model_reasoning: null,
    video_register: null,
    video_squared_at: null,
    video_url: null,
    video_vehicle: null,
    youtube_url: null,
  };
}

// The JS mirror of the embed key-gate: unembedded AND captured.
function matchesEmbedQueue(t: StoredTrack): boolean {
  return t.embedding_blob === null && t.source_audio_key !== null;
}

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation(async (query: { args: unknown[]; sql: string }) => {
    const isCount = query.sql.includes("count(*)");
    // The embed key-gate emits BOTH predicates; model the archive filter off them.
    const wantsEmbedQueue =
      query.sql.includes("embedding_blob is null") &&
      query.sql.includes("source_audio_key is not null");
    const matched = archive
      .filter((t) => (wantsEmbedQueue ? matchesEmbedQueue(t) : true))
      .sort((a, b) => b.added_at.localeCompare(a.added_at));

    if (isCount) {
      return { rows: [{ total_count: matched.length }] };
    }

    const limit = Number(query.args.at(-1));
    return { rows: matched.slice(0, limit).map(fullRow) };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lastListSql(): string {
  const listCall = execute.mock.calls.find(
    (c) => !(c[0] as { sql: string }).sql.includes("count(*)"),
  )?.[0] as { sql: string };

  return listCall.sql;
}

describe("listTracks hasEmbedding=false — the MuQ embed key-gate", () => {
  it("gates the embed worklist on a captured source key (embedding_blob IS NULL AND source_audio_key IS NOT NULL)", async () => {
    await listTracks({ hasEmbedding: false, limit: 50, order: "asc" });
    const sql = lastListSql();

    expect(sql).toContain("embedding_blob is null");
    expect(sql).toContain("source_audio_key is not null");
  });

  it("INCLUDES a keyed-but-unembedded finding; EXCLUDES a keyless one and an already-embedded one", async () => {
    const { tracks } = await listTracks({ hasEmbedding: false, limit: 50, order: "asc" });
    const ids = tracks.map((t) => t.trackId);

    expect(ids).toContain("t-keyed-unembedded");
    expect(ids).not.toContain("t-keyless"); // no captured song → nothing to embed from
    expect(ids).not.toContain("t-embedded"); // already carries a vector
    expect(ids).toEqual(["t-keyed-unembedded"]);
  });

  it("surfaces sourceAudioKey on the DTO so the sweeps can read the captured key", async () => {
    const { tracks } = await listTracks({ hasEmbedding: false, limit: 50, order: "asc" });
    const keyed = tracks.find((t) => t.trackId === "t-keyed-unembedded");

    expect(keyed?.sourceAudioKey).toBe("003.1.1A/abc.m4a");
  });

  it("keeps hasEmbedding=true a pure presence filter (no key gate)", async () => {
    await listTracks({ hasEmbedding: true, limit: 50, order: "asc" });
    const sql = lastListSql();

    expect(sql).toContain("embedding_blob is not null");
    // `source_audio_key` rides in the SELECT list (a surfaced DTO column); what must be
    // absent is the WHERE-clause key GATE — hasEmbedding=true never filters on capture.
    expect(sql).not.toContain("source_audio_key is not null");
  });
});
