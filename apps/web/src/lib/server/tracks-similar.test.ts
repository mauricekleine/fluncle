import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSimilarFindings, type TrackRow } from "./tracks";

// The DB-backed "more like this" reader (docs/audio-embedding-rfc.md) — the data
// source for the public `get_similar_findings` op AND the `/log` row. Drives the real
// function over a mocked `./db`, proving the ranking/exclusion/hydration the row
// renders: sonic order, self excluded, malformed vectors dropped, limit honoured, and
// the graceful empty cases (unknown finding / not-yet-embedded).

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

type EmbRow = { embedding_json: string | null; track_id: string };

/** A 1024-d vector pointing in the (a, b) direction (the rest zero) — a valid MuQ shape. */
function embJson(a: number, b: number): string {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = a;
  vector[1] = b;

  return JSON.stringify(vector);
}

/** A minimal-but-valid `TrackRow` for the hydrate query (only the row's fields set). */
function trackRow(trackId: string, logId: string, title: string, albumImageUrl: string): TrackRow {
  return {
    added_at: "2026-07-06T09:00:00.000Z",
    added_to_spotify: 0,
    album: null,
    album_image_url: albumImageUrl,
    artists_json: '["Artist X"]',
    bpm: null,
    duration_ms: 200000,
    enrichment_status: "done",
    features_json: null,
    in_release_id: null,
    isrc: null,
    key: null,
    label: null,
    log_id: logId,
    note: null,
    observation_alignment_json: null,
    observation_audio_url: null,
    observation_duration_ms: null,
    observation_generated_at: null,
    popularity: null,
    posted_to_telegram: 0,
    preview_url: null,
    release_date: null,
    spotify_url: `https://open.spotify.com/track/${trackId}`,
    tiktok_url: null,
    title,
    track_id: trackId,
    updated_at: null,
    vibe_x: null,
    vibe_y: null,
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

function setupDb(opts: {
  stored: EmbRow[];
  target?: EmbRow;
  tracks: Record<string, TrackRow>;
}): void {
  execute.mockImplementation(async (query: { args?: unknown[]; sql: string }) => {
    const { sql } = query;

    // 1. Target lookup by trackId OR logId.
    if (sql.includes("track_id = ? or log_id = ?")) {
      return { rows: opts.target ? [opts.target] : [] };
    }

    // 2. Candidate scan — honours the `track_id != ?` self-exclusion the real SQL carries.
    if (sql.includes("embedding_json is not null and track_id !=")) {
      const selfId = query.args?.[0];
      return { rows: opts.stored.filter((row) => row.track_id !== selfId) };
    }

    // 3. Hydrate the ranked winners.
    if (sql.includes("track_id in (")) {
      const ids = (query.args ?? []) as string[];
      return { rows: ids.flatMap((id) => (opts.tracks[id] ? [opts.tracks[id]] : [])) };
    }

    return { rows: [] };
  });
}

const SELF: EmbRow = { embedding_json: embJson(1, 0), track_id: "t_self" };

const IDENTICAL = trackRow("t_ident", "004.1.1A", "Identical", "https://img/ident.jpg");
const DIAGONAL = trackRow("t_diag", "004.2.2B", "Diagonal", "https://img/diag.jpg");
const ORTHOGONAL = trackRow("t_orth", "004.3.3C", "Orthogonal", "https://img/orth.jpg");

// A full stored candidate set (as the candidate scan sees it): self (excluded by SQL),
// three real neighbours in decreasing similarity to `t_self`, and one MALFORMED vector
// that passes `IS NOT NULL` but fails the 1024-d parse gate (must be dropped).
const STORED: EmbRow[] = [
  SELF,
  { embedding_json: embJson(1, 0), track_id: "t_ident" }, // cosine 1
  { embedding_json: embJson(1, 1), track_id: "t_diag" }, // cosine ~0.707
  { embedding_json: embJson(0, 1), track_id: "t_orth" }, // cosine 0
  { embedding_json: "[1,2,3]", track_id: "t_bad" }, // wrong length → dropped on parse
];

const TRACKS: Record<string, TrackRow> = {
  t_diag: DIAGONAL,
  t_ident: IDENTICAL,
  t_orth: ORTHOGONAL,
};

beforeEach(() => {
  execute.mockReset();
});

describe("getSimilarFindings", () => {
  it("returns the coordinate-bearing neighbours in descending sonic similarity", async () => {
    setupDb({ stored: STORED, target: SELF, tracks: TRACKS });

    const findings = await getSimilarFindings("t_self");

    // Order: identical (1) > diagonal (~0.707) > orthogonal (0). `t_bad` is dropped
    // (malformed), and `t_self` never appears (the self-exclusion predicate).
    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag", "t_orth"]);
  });

  it("maps each neighbour to the row's display fields (cover, coordinate, identity)", async () => {
    setupDb({ stored: STORED, target: SELF, tracks: TRACKS });

    const [first] = await getSimilarFindings("t_self");

    expect(first).toMatchObject({
      albumImageUrl: "https://img/ident.jpg",
      artists: ["Artist X"],
      logId: "004.1.1A",
      title: "Identical",
      trackId: "t_ident",
    });
  });

  it("honours the limit (the top-N)", async () => {
    setupDb({ stored: STORED, target: SELF, tracks: TRACKS });

    const findings = await getSimilarFindings("t_self", 2);

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag"]);
  });

  it("returns [] for a non-positive limit without touching the DB", async () => {
    setupDb({ stored: STORED, target: SELF, tracks: TRACKS });

    expect(await getSimilarFindings("t_self", 0)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns [] for an unknown finding", async () => {
    setupDb({ stored: STORED, target: undefined, tracks: TRACKS });

    expect(await getSimilarFindings("nope")).toEqual([]);
  });

  it("returns [] when the finding has no embedding yet (the embed cron hasn't drained it)", async () => {
    setupDb({
      stored: STORED,
      target: { embedding_json: null, track_id: "t_self" },
      tracks: TRACKS,
    });

    expect(await getSimilarFindings("t_self")).toEqual([]);
  });

  it("returns [] when nothing else is embedded", async () => {
    setupDb({ stored: [SELF], target: SELF, tracks: TRACKS });

    expect(await getSimilarFindings("t_self")).toEqual([]);
  });
});
