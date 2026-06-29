import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMixtapeCues } from "./mixtapes";

// setMixtapeCues' guards (Fluncle Studio Unit D, panel M1) — the hardened
// post-publish cue backfill. We back getMixtapeById + the member read with a single
// mutable state and answer each query by its SQL shape (the mixtapes.test.ts
// precedent), so the four guards are exercised without a real libsql instance:
//   - it backfills a PUBLISHED mixtape's start_ms (the happy path);
//   - it rejects a non-member ref;
//   - it rejects a non-start-at-0 / non-monotonic cue set;
//   - it rejects an attempt that would change the member set;
//   - (and it rejects a draft, the inverse of assertDraftMixtape).

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  members: [] as Array<{ position: number; track_id: string }>,
  row: {} as Row,
}));

// Capture the writes the backfill batch issues so the happy path can assert the
// per-member start_ms updates landed.
const batchCalls = vi.hoisted(() => ({ last: [] as Array<{ args: unknown[]; sql: string }> }));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    if (query.sql.includes("select track_id, position from mixtape_tracks")) {
      return { rows: state.members };
    }

    // getMixtapeById's MIXTAPE_SELECT (or any other read) → the current mixtape row.
    return { rows: [{ member_count: state.members.length, ...state.row }] };
  }),
);

const batch = vi.hoisted(() =>
  vi.fn(async (statements: Array<{ args: unknown[]; sql: string }>) => {
    batchCalls.last = statements;
    return statements.map(() => ({ rows: [] }));
  }),
);

vi.mock("./db", () => ({
  getDb: async () => ({ batch, execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

vi.mock("./tracks", () => ({
  getTrackByIdOrLogId: async () => undefined,
  getTracksForMixtape: async () => [],
}));

function seed(overrides: Partial<Row> = {}): void {
  state.members = [
    { position: 1, track_id: "t1" },
    { position: 2, track_id: "t2" },
    { position: 3, track_id: "t3" },
  ];
  state.row = {
    created_at: "2026-06-19T00:00:00.000Z",
    id: "mix-1",
    log_id: "020.F.1A",
    member_count: 3,
    recorded_at: "2026-06-19T00:00:00.000Z",
    sequence_number: 1,
    status: "published",
    title: "Fluncle Drum & Bass Mixtape #1 | 020.F.1A",
    updated_at: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
  batchCalls.last = [];
}

describe("setMixtapeCues — post-publish cue backfill", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  it("backfills a published mixtape's per-track start_ms", async () => {
    seed();

    const result = await setMixtapeCues("mix-1", {
      cues: [
        { ref: "t1", startMs: 0 },
        { ref: "t2", startMs: 180_000 },
        { ref: "t3", startMs: 360_000 },
      ],
    });

    expect(result.status).toBe("published");

    // One UPDATE per member (start_ms), each keyed by (mixtape_id, track_id), plus
    // the mixtape updated_at bump.
    const updates = batchCalls.last.filter((s) => s.sql.includes("set start_ms"));
    expect(updates).toHaveLength(3);
    expect(updates.map((s) => s.args)).toEqual([
      [0, "mix-1", "t1"],
      [180_000, "mix-1", "t2"],
      [360_000, "mix-1", "t3"],
    ]);
    expect(batchCalls.last.some((s) => s.sql.includes("update mixtapes set updated_at"))).toBe(
      true,
    );
  });

  it("rejects a ref that isn't a current member", async () => {
    seed();

    await expect(
      setMixtapeCues("mix-1", {
        cues: [
          { ref: "t1", startMs: 0 },
          { ref: "t2", startMs: 180_000 },
          { ref: "nope", startMs: 360_000 },
        ],
      }),
    ).rejects.toThrow(/no current member/i);

    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects a cue set that does not start at 0", async () => {
    seed();

    await expect(
      setMixtapeCues("mix-1", {
        cues: [
          { ref: "t1", startMs: 5_000 },
          { ref: "t2", startMs: 180_000 },
          { ref: "t3", startMs: 360_000 },
        ],
      }),
    ).rejects.toThrow(/start at 0/i);

    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects a non-monotonic cue set", async () => {
    seed();

    await expect(
      setMixtapeCues("mix-1", {
        cues: [
          { ref: "t1", startMs: 0 },
          { ref: "t2", startMs: 180_000 },
          { ref: "t3", startMs: 180_000 },
        ],
      }),
    ).rejects.toThrow(/increase/i);

    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects an attempt that would change the member set (wrong count)", async () => {
    seed();

    await expect(
      setMixtapeCues("mix-1", {
        cues: [
          { ref: "t1", startMs: 0 },
          { ref: "t2", startMs: 180_000 },
        ],
      }),
    ).rejects.toThrow(/exactly the current tracklist/i);

    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects a draft (cues are a post-publish backfill)", async () => {
    seed({ log_id: null, status: "draft" });

    await expect(
      setMixtapeCues("mix-1", {
        cues: [
          { ref: "t1", startMs: 0 },
          { ref: "t2", startMs: 180_000 },
          { ref: "t3", startMs: 360_000 },
        ],
      }),
    ).rejects.toThrow(/publish the mixtape first/i);

    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects an empty cue list", async () => {
    seed();

    await expect(setMixtapeCues("mix-1", { cues: [] })).rejects.toThrow(/cue for every track/i);
    expect(batch).not.toHaveBeenCalled();
  });
});
