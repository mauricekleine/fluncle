import { beforeEach, describe, expect, it, vi } from "vitest";
import { addTracksToMixtape, listMixtapeMembershipsForTracks } from "./mixtapes";

// addTracksToMixtape's DB choreography: assertDraftMixtape (a `select status` execute)
// → the current-members read (`select track_id, position from mixtape_tracks`) →
// getTrackByIdOrLogId per ref → an insert batch (only when there's something new) →
// a final getMixtapeById readback. We answer each query by its SQL shape and capture
// the batch so we can assert what got inserted, and where.

type Insert = { mixtapeId: string; position: number; startMs: number | null; trackId: string };

const state = vi.hoisted(() => ({
  existing: [] as { position: number; track_id: string }[],
  inserts: [] as Insert[],
  memberships: [] as Record<string, unknown>[],
  notFound: new Set<string>(),
  status: "draft" as string,
}));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    if (query.sql.includes("select status from mixtapes where id")) {
      return { rows: [{ status: state.status }] };
    }
    if (query.sql.includes("track_id, position from mixtape_tracks")) {
      return { rows: state.existing };
    }
    if (query.sql.includes("join mixtapes m on m.id = mt.mixtape_id")) {
      return { rows: state.memberships };
    }
    // getMixtapeById's MIXTAPE_SELECT readback.
    return { rows: [{ id: "mix-1", member_count: 1, status: state.status, title: "Draft" }] };
  }),
);

const batch = vi.hoisted(() =>
  vi.fn(async (ops: { args: unknown[]; sql: string }[]) => {
    for (const op of ops) {
      if (op.sql.includes("insert into mixtape_tracks")) {
        const [mixtapeId, trackId, position, startMs] = op.args as [string, string, number, number];
        state.inserts.push({ mixtapeId, position, startMs: startMs ?? null, trackId });
      }
    }
    return [{ rows: [] }];
  }),
);

vi.mock("./db", () => ({
  getDb: async () => ({ batch, execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

vi.mock("./tracks", () => ({
  getTrackByIdOrLogId: async (ref: string) =>
    state.notFound.has(ref) ? undefined : { trackId: ref },
  getTracksForMixtape: async () => [],
}));

beforeEach(() => {
  execute.mockClear();
  batch.mockClear();
  state.existing = [];
  state.inserts = [];
  state.memberships = [];
  state.notFound = new Set();
  state.status = "draft";
});

describe("addTracksToMixtape — append, don't replace", () => {
  it("appends new findings after the existing tracklist, continuing positions", async () => {
    state.existing = [
      { position: 1, track_id: "a" },
      { position: 2, track_id: "b" },
    ];

    await addTracksToMixtape("mix-1", { members: ["c", "d"] });

    expect(state.inserts).toEqual([
      { mixtapeId: "mix-1", position: 3, startMs: null, trackId: "c" },
      { mixtapeId: "mix-1", position: 4, startMs: null, trackId: "d" },
    ]);
  });

  it("skips findings already on the tape and de-dupes the input", async () => {
    state.existing = [{ position: 1, track_id: "a" }];

    await addTracksToMixtape("mix-1", { members: ["a", "b", "b"] });

    expect(state.inserts).toEqual([
      { mixtapeId: "mix-1", position: 2, startMs: null, trackId: "b" },
    ]);
  });

  it("no-ops (no write) when every finding is already present", async () => {
    state.existing = [{ position: 1, track_id: "a" }];

    await addTracksToMixtape("mix-1", { members: ["a"] });

    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects an empty member list", async () => {
    await expect(addTracksToMixtape("mix-1", { members: [] })).rejects.toThrow(/at least one/i);
  });

  it("refuses a minted (non-draft) mixtape", async () => {
    state.status = "distributing";

    await expect(addTracksToMixtape("mix-1", { members: ["a"] })).rejects.toThrow(/published/i);
  });

  it("rejects an unknown finding ref", async () => {
    state.notFound = new Set(["ghost"]);

    await expect(addTracksToMixtape("mix-1", { members: ["ghost"] })).rejects.toThrow(
      /no finding/i,
    );
  });
});

describe("listMixtapeMembershipsForTracks", () => {
  it("returns an empty map without touching the db for no ids", async () => {
    const result = await listMixtapeMembershipsForTracks([]);

    expect(result).toEqual({});
    expect(execute).not.toHaveBeenCalled();
  });

  it("keys memberships by trackId, carrying status, logId, and title", async () => {
    state.memberships = [
      {
        log_id: "019.F.1A",
        mixtape_id: "mix-1",
        status: "published",
        title: "Tape #1",
        track_id: "a",
      },
      { log_id: null, mixtape_id: "mix-2", status: "draft", title: "", track_id: "a" },
      { log_id: null, mixtape_id: "mix-2", status: "draft", title: "", track_id: "b" },
    ];

    const result = await listMixtapeMembershipsForTracks(["a", "b"]);

    expect(result.a).toEqual([
      { logId: "019.F.1A", mixtapeId: "mix-1", status: "published", title: "Tape #1" },
      { logId: undefined, mixtapeId: "mix-2", status: "draft", title: "" },
    ]);
    expect(result.b).toEqual([
      { logId: undefined, mixtapeId: "mix-2", status: "draft", title: "" },
    ]);
  });
});
