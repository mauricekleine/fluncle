import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMixtapeMembershipsForTracks, setMixtapeMembers } from "./mixtapes";

// setMixtapeMembers' DB choreography: assertUnmintedMixtape (a `select status,
// log_id` execute) → getTrackByIdOrLogId per ref → the replace batch (delete +
// one insert per member) → a final getMixtapeById readback. This is the promote
// path's member seed: it writes only an UNMINTED claim (no Log ID yet) — the
// immutability backstop that keeps a minted checkpoint's tracklist frozen. We
// answer each query by its SQL shape and capture the batch so we can assert what
// got inserted, and where.

type Insert = { mixtapeId: string; position: number; startMs: number | null; trackId: string };

const state = vi.hoisted(() => ({
  inserts: [] as Insert[],
  logId: null as string | null,
  memberships: [] as Record<string, unknown>[],
  notFound: new Set<string>(),
  status: "distributing" as string,
}));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    if (query.sql.includes("select status, log_id from mixtapes where id")) {
      return { rows: [{ log_id: state.logId, status: state.status }] };
    }
    if (query.sql.includes("join mixtapes m on m.id = mt.mixtape_id")) {
      return { rows: state.memberships };
    }
    // getMixtapeById's MIXTAPE_SELECT readback.
    return {
      rows: [
        { id: "mix-1", log_id: state.logId, member_count: 1, status: state.status, title: "" },
      ],
    };
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
  state.inserts = [];
  state.logId = null;
  state.memberships = [];
  state.notFound = new Set();
  state.status = "distributing";
});

describe("setMixtapeMembers — seed an unminted claim's tracklist", () => {
  it("replaces the tracklist in order (delete, then position 1..n inserts)", async () => {
    await setMixtapeMembers("mix-1", { members: ["a", "b", "c"] });

    expect(state.inserts).toEqual([
      { mixtapeId: "mix-1", position: 1, startMs: null, trackId: "a" },
      { mixtapeId: "mix-1", position: 2, startMs: null, trackId: "b" },
      { mixtapeId: "mix-1", position: 3, startMs: null, trackId: "c" },
    ]);
    expect(batch.mock.calls[0]?.[0]?.[0]?.sql).toContain("delete from mixtape_tracks");
  });

  it("carries each member's startMs into its row", async () => {
    await setMixtapeMembers("mix-1", {
      members: [
        { ref: "a", startMs: 0 },
        { ref: "b", startMs: 180_000 },
      ],
    });

    expect(state.inserts).toEqual([
      { mixtapeId: "mix-1", position: 1, startMs: 0, trackId: "a" },
      { mixtapeId: "mix-1", position: 2, startMs: 180_000, trackId: "b" },
    ]);
  });

  it("rejects an empty member list", async () => {
    await expect(setMixtapeMembers("mix-1", { members: [] })).rejects.toThrow(/at least one/i);
  });

  it("refuses a MINTED mixtape — the tracklist froze at the mint", async () => {
    state.logId = "020.F.1A";
    state.status = "published";

    await expect(setMixtapeMembers("mix-1", { members: ["a"] })).rejects.toThrow(
      /checkpoint fixed/i,
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("refuses a minted-but-distributing mixtape too (the Log ID is the gate)", async () => {
    state.logId = "020.F.1A";
    state.status = "distributing";

    await expect(setMixtapeMembers("mix-1", { members: ["a"] })).rejects.toThrow(
      /checkpoint fixed/i,
    );
  });

  it("rejects a duplicate member", async () => {
    await expect(setMixtapeMembers("mix-1", { members: ["a", "a"] })).rejects.toThrow(
      /only appear once/i,
    );
  });

  it("rejects an unknown finding ref", async () => {
    state.notFound = new Set(["ghost"]);

    await expect(setMixtapeMembers("mix-1", { members: ["ghost"] })).rejects.toThrow(/no finding/i);
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
      { log_id: "020.F.1B", mixtape_id: "mix-2", status: "distributing", title: "", track_id: "a" },
      { log_id: "020.F.1B", mixtape_id: "mix-2", status: "distributing", title: "", track_id: "b" },
    ];

    const result = await listMixtapeMembershipsForTracks(["a", "b"]);

    expect(result.a).toEqual([
      { logId: "019.F.1A", mixtapeId: "mix-1", status: "published", title: "Tape #1" },
      { logId: "020.F.1B", mixtapeId: "mix-2", status: "distributing", title: "" },
    ]);
    expect(result.b).toEqual([
      { logId: "020.F.1B", mixtapeId: "mix-2", status: "distributing", title: "" },
    ]);
  });
});
