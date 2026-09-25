import { beforeEach, describe, expect, it, vi } from "vitest";
import { promoteRecording } from "./recordings";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  calls: [] as string[],
  catalogue: [] as Row[],
  cues: [] as Row[],
  joinLogId: null as string | null,
  joinMixtapeId: null as string | null,
  linked: undefined as { id: string; log_id: string | null } | undefined,
  recording: {} as Row,
}));

const defaultExecute = vi.hoisted(() => async (query: { args: unknown[]; sql: string }) => {
  const sql = query.sql;

  if (sql.includes("left join mixtapes")) {
    return {
      rows: [
        { ...state.recording, mixtape_id: state.joinMixtapeId, mixtape_log_id: state.joinLogId },
      ],
    };
  }

  if (sql.includes("from recording_cues")) {
    return { rows: state.cues };
  }

  if (sql.includes("artists_json from tracks")) {
    return { rows: state.catalogue };
  }

  if (sql.includes("from recordings where id")) {
    return { rows: [state.recording] };
  }

  if (sql.startsWith("insert into mixtapes")) {
    state.calls.push("claim");
    return { rows: [], rowsAffected: state.linked ? 0 : 1 };
  }

  if (sql.includes("from mixtapes where recording_id")) {
    return { rows: state.linked ? [state.linked] : [] };
  }

  if (sql.startsWith("update mixtapes set recording_id")) {
    state.calls.push("link");
    return { rows: [] };
  }

  if (sql.startsWith("update recordings set r2_key")) {
    state.calls.push("repoint");
    state.recording.r2_key = query.args[0];
    return { rows: [] };
  }

  return { rows: [] };
});

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

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

function seedRecording(overrides: Row = {}): void {
  state.recording = {
    created_at: "2026-06-30T00:00:00.000Z",
    duration_ms: 3_600_000,
    id: "rec-1",
    r2_key: "recordings/rec-1/set.mp4",
    recorded_at: "2026-06-30T00:00:00.000Z",
    title: "Warehouse set",
    updated_at: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
  state.cues = [
    {
      artists_text: "A",
      finding_id: "t1",
      id: "cue-1",
      position: 1,
      start_ms: 0,
      title_text: "T",
    },
  ];
}

beforeEach(() => {
  state.calls = [];
  state.catalogue = [];
  state.cues = [];
  state.linked = undefined;
  state.joinLogId = null;
  state.joinMixtapeId = null;
  execute.mockReset();
  execute.mockImplementation(defaultExecute);
  publishMixtape.mockClear();
  setMixtapeMembers.mockClear();
  updateMixtape.mockClear();
  copyObject.mockClear();
  deleteObject.mockClear();
});

describe("promoteRecording", () => {
  it("mints once on a fresh recording, then copies → repoints → deletes the source key LAST", async () => {
    seedRecording();

    const recording = await promoteRecording("rec-1");

    expect(state.calls).toContain("claim");
    expect(state.calls.indexOf("claim")).toBeLessThan(state.calls.indexOf("mint"));
    expect(setMixtapeMembers).toHaveBeenCalledTimes(1);
    expect(publishMixtape).toHaveBeenCalledTimes(1);

    expect(copyObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4", "020.F.1A/set.mp4");

    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("copy"));
    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("repoint"));
    expect(deleteObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4");

    expect(recording.logId).toBe("020.F.1A");
    expect(recording.r2Key).toBe("020.F.1A/set.mp4");
  });

  it("is a no-op on R2 for a fully-promoted re-run (reuse, no second mint, no copy/delete)", async () => {
    seedRecording({ r2_key: "020.F.1A/set.mp4" });
    state.linked = { id: "mix-1", log_id: "020.F.1A" };
    state.joinLogId = "020.F.1A";
    state.joinMixtapeId = "mix-1";

    await promoteRecording("rec-1");

    expect(state.calls).not.toContain("claim");
    expect(publishMixtape).not.toHaveBeenCalled();
    expect(copyObject).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(updateMixtape).toHaveBeenCalledTimes(1);
  });

  it("reuses the linked mixtape but still copies+repoints when a prior run left the key un-repointed", async () => {
    seedRecording({ r2_key: "recordings/rec-1/set.mp4" });
    state.linked = { id: "mix-1", log_id: "020.F.1A" };
    state.joinLogId = "020.F.1A";
    state.joinMixtapeId = "mix-1";

    await promoteRecording("rec-1");

    expect(state.calls).not.toContain("claim");
    expect(publishMixtape).not.toHaveBeenCalled();
    expect(copyObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4", "020.F.1A/set.mp4");
    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("repoint"));
  });

  it("seeds the mixtape members from the cues' finding_id links (the S4 fix)", async () => {
    seedRecording();
    state.cues = [
      { artists_text: "A", finding_id: "t1", id: "c1", position: 1, start_ms: 0, title_text: "T" },
      {
        artists_text: "B",
        finding_id: null,
        id: "c2",
        position: 2,
        start_ms: 90_000,
        title_text: "U",
      },
      {
        artists_text: "A",
        finding_id: "t1",
        id: "c3",
        position: 3,
        start_ms: 180_000,
        title_text: "T",
      },
    ];

    await promoteRecording("rec-1");

    expect(setMixtapeMembers).toHaveBeenCalledWith(expect.any(String), {
      members: [{ ref: "t1", startMs: 0 }],
    });
  });

  it("refuses to mint a recording whose cues resolve to no finding (BEFORE claiming a link)", async () => {
    seedRecording();
    state.cues = [];

    await expect(promoteRecording("rec-1")).rejects.toThrow(/no Fluncle finding|resolvable/i);
    expect(state.calls).not.toContain("claim");
    expect(publishMixtape).not.toHaveBeenCalled();
  });

  it("refuses to mint a recording whose only cue is a non-finding (no finding_id)", async () => {
    seedRecording();
    state.cues = [
      { artists_text: "B", finding_id: null, id: "c1", position: 1, start_ms: 0, title_text: "U" },
    ];

    await expect(promoteRecording("rec-1")).rejects.toThrow(/no Fluncle finding|resolvable/i);
    expect(state.calls).not.toContain("claim");
    expect(publishMixtape).not.toHaveBeenCalled();
  });

  it("recovers a half-claimed row (linked, no log_id): reuses the row, mints no new coordinate", async () => {
    seedRecording();
    state.linked = { id: "mix-1", log_id: null };

    await promoteRecording("rec-1");

    expect(state.calls).not.toContain("claim");
    expect(setMixtapeMembers).toHaveBeenCalledWith("mix-1", {
      members: [{ ref: "t1", startMs: 0 }],
    });
    expect(publishMixtape).toHaveBeenCalledTimes(1);
  });

  it("loses the claim race → reuses the winner's row, never mints a second coordinate", async () => {
    seedRecording();
    let probed = 0;
    execute.mockImplementation(async (query: { args: unknown[]; sql: string }) => {
      const sql = query.sql;

      if (sql.includes("left join mixtapes")) {
        return {
          rows: [
            {
              ...state.recording,
              mixtape_id: state.joinMixtapeId,
              mixtape_log_id: state.joinLogId,
            },
          ],
        };
      }
      if (sql.includes("from recording_cues")) {
        return { rows: state.cues };
      }
      if (sql.includes("from recordings where id")) {
        return { rows: [state.recording] };
      }
      if (sql.startsWith("insert into mixtapes")) {
        state.calls.push("claim");
        return { rows: [], rowsAffected: 0 };
      }
      if (sql.includes("from mixtapes where recording_id")) {
        probed += 1;
        return { rows: probed === 1 ? [] : [{ id: "winner-mix" }] };
      }
      if (sql.startsWith("update recordings set r2_key")) {
        state.calls.push("repoint");
        state.recording.r2_key = query.args[0];
        return { rows: [] };
      }

      return { rows: [] };
    });

    await promoteRecording("rec-1");

    expect(setMixtapeMembers).toHaveBeenCalledWith("winner-mix", {
      members: [{ ref: "t1", startMs: 0 }],
    });
  });

  it("refuses to promote a PLAN (no set video — r2_key NULL)", async () => {
    seedRecording({ r2_key: null });

    await expect(promoteRecording("rec-1")).rejects.toThrow(/no set video/i);
    expect(state.calls).not.toContain("claim");
    expect(copyObject).not.toHaveBeenCalled();
  });
});
