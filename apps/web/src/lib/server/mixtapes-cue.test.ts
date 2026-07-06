import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMixtapeCue } from "./mixtapes";

// setMixtapeCue's guards (the Fluncle Studio cue rail's interactive single-cue write).
// The mixtapes-cues.test.ts precedent: back getMixtapeById + the member read with one
// mutable state answered by SQL shape, so the guards run without a real libsql. Unlike
// the batch setMixtapeCues, this op has NO coverage/monotonic constraint — it upserts
// or clears exactly one member's start_ms:
//   - it marks one member on a published set (the happy path);
//   - it clears a cue when startMs is null;
//   - it rejects a non-member ref;
//   - it rejects an unminted claim (cues mark a minted set);
//   - it rejects a bad startMs shape.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  members: [] as Array<{ position: number; track_id: string }>,
  row: {} as Row,
  track: undefined as { trackId: string } | undefined,
}));

const batchCalls = vi.hoisted(() => ({ last: [] as Array<{ args: unknown[]; sql: string }> }));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    if (query.sql.includes("select track_id, position from mixtape_tracks")) {
      return { rows: state.members };
    }

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

// Resolve a ref by reading the mutable `state.track` — each test sets it to the finding
// the ref should resolve to (or undefined for the unknown-ref case).
vi.mock("./tracks", () => ({
  getTrackByIdOrLogId: async () => state.track,
  getTracksForMixtape: async () => [],
}));

function seed(overrides: Partial<Row> = {}): void {
  state.members = [
    { position: 1, track_id: "t1" },
    { position: 2, track_id: "t2" },
    { position: 3, track_id: "t3" },
  ];
  state.track = { trackId: "t2" };
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

describe("setMixtapeCue — interactive single-cue write", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  it("marks one member's start_ms on a published set", async () => {
    seed();

    const result = await setMixtapeCue("mix-1", { ref: "t2", startMs: 180_000 });

    expect(result.status).toBe("published");

    const updates = batchCalls.last.filter((s) => s.sql.includes("set start_ms"));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toEqual([180_000, "mix-1", "t2"]);
    expect(batchCalls.last.some((s) => s.sql.includes("update mixtapes set updated_at"))).toBe(
      true,
    );
  });

  it("marks a member out of order without complaint (no monotonic constraint)", async () => {
    seed();
    state.track = { trackId: "t3" };

    await setMixtapeCue("mix-1", { ref: "t3", startMs: 5_000 });

    const updates = batchCalls.last.filter((s) => s.sql.includes("set start_ms"));
    expect(updates[0]?.args).toEqual([5_000, "mix-1", "t3"]);
  });

  it("clears a cue when startMs is null", async () => {
    seed();

    await setMixtapeCue("mix-1", { ref: "t2", startMs: null });

    const updates = batchCalls.last.filter((s) => s.sql.includes("set start_ms"));
    expect(updates[0]?.args).toEqual([null, "mix-1", "t2"]);
  });

  it("rejects a ref that isn't a current member", async () => {
    seed();
    state.track = { trackId: "nope" };

    await expect(setMixtapeCue("mix-1", { ref: "nope", startMs: 0 })).rejects.toThrow(
      /no current member/i,
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects an unknown finding ref (resolves to nothing)", async () => {
    seed();
    state.track = undefined;

    await expect(setMixtapeCue("mix-1", { ref: "ghost", startMs: 0 })).rejects.toThrow(
      /no finding with id/i,
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects an unminted claim (cues mark a minted set)", async () => {
    seed({ log_id: null, status: "distributing" });

    await expect(setMixtapeCue("mix-1", { ref: "t2", startMs: 0 })).rejects.toThrow(
      /promote the recording first/i,
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects a bad startMs shape (not an integer, not null)", async () => {
    seed();

    await expect(setMixtapeCue("mix-1", { ref: "t2", startMs: -1 })).rejects.toThrow(
      /non-negative integer/i,
    );
    await expect(setMixtapeCue("mix-1", { ref: "t2", startMs: 1.5 })).rejects.toThrow(
      /non-negative integer/i,
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects a missing ref", async () => {
    seed();

    await expect(setMixtapeCue("mix-1", { ref: "", startMs: 0 })).rejects.toThrow(
      /needs a track ref/i,
    );
    expect(batch).not.toHaveBeenCalled();
  });
});
