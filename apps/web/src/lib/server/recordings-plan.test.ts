import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecording, replaceRecordingCues, updateRecording } from "./recordings";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  existingTitles: new Set<string>(),
  recording: {} as Row,
}));

const batch = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));

const defaultExecute = vi.hoisted(() => async (query: { args: unknown[]; sql: string }) => {
  const sql = query.sql;

  if (sql.includes("from recordings where title")) {
    const title = String(query.args[0]);
    return { rows: state.existingTitles.has(title) ? [{ 1: 1 }] : [] };
  }

  if (sql.includes("left join mixtapes")) {
    return { rows: [{ ...state.recording, mixtape_id: null, mixtape_log_id: null }] };
  }

  if (sql.includes("from recording_cues")) {
    return { rows: [] };
  }

  if (sql.includes("from recordings where id")) {
    return { rows: [state.recording] };
  }

  return { rows: [] };
});

const execute = vi.hoisted(() => vi.fn());

const uuid = vi.hoisted(() => ({ fixed: undefined as string | undefined }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();

  return { ...actual, randomUUID: () => uuid.fixed ?? actual.randomUUID() };
});

const DISTINCT_FIRST_ROLLS_ID = "00000000-0000-4000-8000-000000000000";
const REPEATED_FIRST_ROLL_ID = "00000000-0000-4000-8000-000000000090";

function titleProbes(): string[] {
  return execute.mock.calls
    .map((call) => call[0] as { args: unknown[]; sql: string })
    .filter((query) => query.sql.includes("from recordings where title"))
    .map((query) => String(query.args[0]));
}

vi.mock("./db", () => ({
  getDb: async () => ({ batch, execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

function recordingInsertArgs(): [string, string, string | null, ...unknown[]] {
  const call = execute.mock.calls.find((entry) =>
    String((entry[0] as { sql: string }).sql).startsWith("insert into recordings"),
  );

  if (!call) {
    throw new Error("no `insert into recordings` was executed");
  }

  return (call[0] as { args: [string, string, string | null, ...unknown[]] }).args;
}

function seedRecording(overrides: Row = {}): void {
  state.recording = {
    created_at: "2026-07-03T00:00:00.000Z",
    duration_ms: null,
    id: "rec-1",
    parent_id: null,
    r2_key: null,
    recorded_at: null,
    title: "liquid-nebula-roller",
    updated_at: "2026-07-03T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  state.existingTitles = new Set();
  uuid.fixed = undefined;
  seedRecording();
  execute.mockReset();
  execute.mockImplementation(defaultExecute);
  batch.mockClear();
});

describe("createRecording — a plan (videoless)", () => {
  it("mints a Galaxy-vocab handle + leaves r2_key NULL (no video)", async () => {
    await createRecording({ kind: "plan" });

    const [, title, r2Key] = recordingInsertArgs();

    expect(title).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(r2Key).toBeNull();
  });

  it("re-rolls the handle on a collision among existing recording titles", async () => {
    const { galaxySlug } = await import("@fluncle/contracts/util/galaxy-slug");
    uuid.fixed = DISTINCT_FIRST_ROLLS_ID;
    const firstRoll = galaxySlug(DISTINCT_FIRST_ROLLS_ID, 0);
    const secondRoll = galaxySlug(DISTINCT_FIRST_ROLLS_ID, 1);

    expect(secondRoll).not.toBe(firstRoll);

    state.existingTitles = new Set([firstRoll]);

    await createRecording({ kind: "plan" });

    const [id, title] = recordingInsertArgs();

    expect(id).toBe(DISTINCT_FIRST_ROLLS_ID);
    expect(title).toBe(secondRoll);
    expect(titleProbes()).toEqual([firstRoll, secondRoll]);
  });

  it("never probes the same handle twice when two attempts roll the same slug", async () => {
    const { galaxySlug } = await import("@fluncle/contracts/util/galaxy-slug");
    uuid.fixed = REPEATED_FIRST_ROLL_ID;
    const firstRoll = galaxySlug(REPEATED_FIRST_ROLL_ID, 0);
    const thirdRoll = galaxySlug(REPEATED_FIRST_ROLL_ID, 2);

    expect(galaxySlug(REPEATED_FIRST_ROLL_ID, 1)).toBe(firstRoll);
    expect(thirdRoll).not.toBe(firstRoll);

    state.existingTitles = new Set([firstRoll]);

    await createRecording({ kind: "plan" });

    const [, title] = recordingInsertArgs();

    expect(title).toBe(thirdRoll);
    expect(titleProbes()).toEqual([firstRoll, thirdRoll]);
  });

  it("still requires a title for a TAKE (non-plan) create", async () => {
    await expect(createRecording({})).rejects.toThrow(/title is required/i);
  });
});

describe("updateRecording — attach a take to its plan (atomic version)", () => {
  it("assigns version via an atomic max()+1 subquery scoped to the plan's takes", async () => {
    await updateRecording("take-1", { parentId: "plan-1" });

    const update = execute.mock.calls
      .map((call) => call[0] as { args: unknown[]; sql: string })
      .find((query) => query.sql.startsWith("update recordings set"));

    expect(update).toBeDefined();
    expect(update?.sql).toContain(
      "version = (select coalesce(max(version), 0) + 1 from recordings where parent_id is ? and id <> ?)",
    );
    expect(update?.args).toContain("plan-1");
    expect(update?.args).toContain("take-1");
  });

  it("detaches (parentId null) without touching version", async () => {
    await updateRecording("take-1", { parentId: null });

    const update = execute.mock.calls
      .map((call) => call[0] as { args: unknown[]; sql: string })
      .find((query) => query.sql.startsWith("update recordings set"));

    expect(update?.sql).toContain("parent_id = ?");
    expect(update?.sql).not.toContain("version =");
  });
});

describe("replaceRecordingCues", () => {
  it("reindexes positions 1..n and writes each cue's finding link + snapshot transactionally", async () => {
    await replaceRecordingCues("rec-1", [
      {
        artistsText: "Alix Perez",
        findingId: "t1",
        position: 5,
        startMs: 0,
        titleText: "Burning Babylon",
      },
      { artistsText: "Calibre", findingId: null, position: 9, titleText: "Mr Right On" },
    ]);

    expect(batch).toHaveBeenCalledTimes(1);
    const statements = batch.mock.calls[0]?.[0] as Array<{ args: unknown[]; sql: string }>;

    expect(statements[0]?.sql).toContain("delete from recording_cues where recording_id = ?");
    const inserts = statements.filter((s) => s.sql.includes("insert into recording_cues"));
    expect(inserts).toHaveLength(2);

    expect(inserts[0]?.args[5]).toBe(1);
    expect(inserts[1]?.args[5]).toBe(2);
    expect(inserts[0]?.args[2]).toBe("t1");
    expect(inserts[1]?.args[2]).toBeNull();
  });

  it("rejects a cue with neither a finding link nor snapshot text", async () => {
    await expect(replaceRecordingCues("rec-1", [{ position: 1 }])).rejects.toThrow(
      /findingId or artistsText/i,
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("clears the cues on an empty array", async () => {
    await replaceRecordingCues("rec-1", []);

    const statements = batch.mock.calls[0]?.[0] as Array<{ args: unknown[]; sql: string }>;
    expect(statements.some((s) => s.sql.includes("insert into recording_cues"))).toBe(false);
    expect(statements.some((s) => s.sql.includes("delete from recording_cues"))).toBe(true);
  });
});
