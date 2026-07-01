import { beforeEach, describe, expect, it, vi } from "vitest";
import { promoteRecording } from "./recordings";

// promoteRecording's idempotency (RFC recording-primitive, Design B). The mixtapes-cue
// precedent: back the DB reads with one mutable state answered by SQL shape, and mock the
// mint path (./mixtapes) + the R2 copy/delete (./r2-presign) so the orchestration runs
// without a real libsql or R2. The three invariants under test:
//   - MINT-OR-REUSE: a fresh recording mints exactly one mixtape; a recording already
//     linked to a minted mixtape reuses it and NEVER mints again.
//   - COPY → REPOINT → DELETE-LAST: the set video is copied to `<logId>/set.mp4`, the
//     recording's r2Key is repointed there, and the OLD key is deleted LAST.
//   - a fully-promoted re-run is a no-op on R2 (no copy-onto-itself, no delete).

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  calls: [] as string[],
  joinLogId: null as string | null,
  joinMixtapeId: null as string | null,
  linked: undefined as { id: string; log_id: string | null } | undefined,
  recording: {} as Row,
}));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    const sql = query.sql;

    // getRecording (the DTO read) — recordings LEFT JOIN mixtapes.
    if (sql.includes("left join mixtapes")) {
      return {
        rows: [
          { ...state.recording, mixtape_id: state.joinMixtapeId, mixtape_log_id: state.joinLogId },
        ],
      };
    }

    // getRecordingRow — the raw recordings row.
    if (sql.includes("from recordings where id")) {
      return { rows: [state.recording] };
    }

    // mint-or-reuse probe.
    if (sql.includes("from mixtapes where recording_id")) {
      return { rows: state.linked ? [state.linked] : [] };
    }

    // link the freshly minted mixtape back to the recording.
    if (sql.startsWith("update mixtapes set recording_id")) {
      state.calls.push("link");
      return { rows: [] };
    }

    // repoint the recording's owned key to the promoted mixtape's key.
    if (sql.startsWith("update recordings set r2_key")) {
      state.calls.push("repoint");
      state.recording.r2_key = query.args[0];
      return { rows: [] };
    }

    return { rows: [] };
  }),
);

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const createMixtape = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("create");
    return { id: "mix-1" };
  }),
);
const publishMixtape = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("mint");
    state.joinLogId = "020.F.1A";
    state.joinMixtapeId = "mix-1";
    return { logId: "020.F.1A" };
  }),
);
const setMixtapeMembers = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("members");
    return {};
  }),
);
const updateMixtape = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("flip");
    return {};
  }),
);

vi.mock("./mixtapes", () => ({
  createMixtape,
  publishMixtape,
  setMixtapeMembers,
  updateMixtape,
}));

const copyObject = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("copy");
  }),
);
const deleteObject = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("delete");
  }),
);

vi.mock("./r2-presign", () => ({ copyObject, deleteObject }));

vi.mock("./tracks", () => ({
  getTrackByIdOrLogId: async () => ({ trackId: "t1" }),
}));

function seedRecording(overrides: Row = {}): void {
  state.recording = {
    created_at: "2026-06-30T00:00:00.000Z",
    duration_ms: 3_600_000,
    id: "rec-1",
    r2_key: "recordings/rec-1/set.mp4",
    recorded_at: "2026-06-30T00:00:00.000Z",
    title: "Warehouse set",
    tracklist_json: JSON.stringify([{ artists: ["A"], id: "cue-1", startMs: 0, title: "T" }]),
    updated_at: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  state.calls = [];
  state.linked = undefined;
  state.joinLogId = null;
  state.joinMixtapeId = null;
  execute.mockClear();
  createMixtape.mockClear();
  publishMixtape.mockClear();
  setMixtapeMembers.mockClear();
  updateMixtape.mockClear();
  copyObject.mockClear();
  deleteObject.mockClear();
});

describe("promoteRecording", () => {
  it("mints once on a fresh recording, then copies → repoints → deletes the old key LAST", async () => {
    seedRecording();

    const recording = await promoteRecording("rec-1");

    // Minted exactly one mixtape, seeded from the resolved tracklist.
    expect(createMixtape).toHaveBeenCalledTimes(1);
    expect(setMixtapeMembers).toHaveBeenCalledTimes(1);
    expect(publishMixtape).toHaveBeenCalledTimes(1);

    // Copied the set video from the owned key to the minted mixtape's derived key.
    expect(copyObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4", "020.F.1A/set.mp4");

    // The old key is deleted LAST — after the copy AND after the r2Key repoint.
    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("copy"));
    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("repoint"));
    expect(deleteObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4");

    // The returned recording now carries the promoted coordinate.
    expect(recording.logId).toBe("020.F.1A");
    expect(recording.r2Key).toBe("020.F.1A/set.mp4");
  });

  it("is a no-op on R2 for a fully-promoted re-run (reuse, no second mint, no copy/delete)", async () => {
    // The recording is already repointed at the promoted key + linked to its mixtape.
    seedRecording({ r2_key: "020.F.1A/set.mp4" });
    state.linked = { id: "mix-1", log_id: "020.F.1A" };
    state.joinLogId = "020.F.1A";
    state.joinMixtapeId = "mix-1";

    await promoteRecording("rec-1");

    // NEVER re-mints a scarce coordinate.
    expect(createMixtape).not.toHaveBeenCalled();
    expect(publishMixtape).not.toHaveBeenCalled();
    // No copy-onto-itself, no delete of the live key.
    expect(copyObject).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    // The setVideoAt flip is still idempotently re-applied.
    expect(updateMixtape).toHaveBeenCalledTimes(1);
  });

  it("reuses the linked mixtape but still copies+repoints when a prior run left the key un-repointed", async () => {
    // Linked + minted, but the recording's key was never repointed (a half-finished run).
    seedRecording({ r2_key: "recordings/rec-1/set.mp4" });
    state.linked = { id: "mix-1", log_id: "020.F.1A" };
    state.joinLogId = "020.F.1A";
    state.joinMixtapeId = "mix-1";

    await promoteRecording("rec-1");

    // No second mint (reuse) …
    expect(createMixtape).not.toHaveBeenCalled();
    expect(publishMixtape).not.toHaveBeenCalled();
    // … but the copy + repoint + delete-last still complete the promotion.
    expect(copyObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4", "020.F.1A/set.mp4");
    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("repoint"));
  });

  it("refuses to mint a recording whose tracklist resolves to no finding", async () => {
    seedRecording({ tracklist_json: JSON.stringify([]) });

    await expect(promoteRecording("rec-1")).rejects.toThrow(/no Fluncle finding|resolvable/i);
    expect(createMixtape).not.toHaveBeenCalled();
  });
});
