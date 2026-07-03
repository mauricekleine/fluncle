import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MIXTAPE_TITLE, publishMixtape } from "./mixtapes";

// publishMixtape's DB choreography: getMixtapeById (a MIXTAPE_SELECT execute) → the
// cap pre-check (a max(sequence_number) execute) → the mint batch (returning log_id
// + sequence_number, status → 'distributing') → an optional title update execute →
// a final getMixtapeById readback. We back it with a single mutable row and answer
// each query by its SQL shape — enough to prove the gate + mint-to-distributing +
// canonicalization without a real libsql instance.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ nextSequence: 1, row: {} as Row }));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    if (query.sql.includes("update mixtapes set title = ?")) {
      const [title] = query.args as [string];
      state.row.title = title;
      return { rows: [] };
    }

    // The cap pre-check (nextMixtapeSequence).
    if (query.sql.includes("coalesce(max(sequence_number), 0) + 1")) {
      return { rows: [{ n: state.nextSequence }] };
    }

    // getMixtapeById runs a MIXTAPE_SELECT; return the current row state (the select
    // projects member_count, default it to 1).
    return { rows: [{ member_count: 1, ...state.row }] };
  }),
);

const batch = vi.hoisted(() =>
  vi.fn(async (queries: Array<{ args: unknown[] }>) => {
    // The mint batch stamps the minted coordinate onto the row (status →
    // 'distributing', NOT 'published' — the first platform link publishes it later).
    // Mirror the real SQL: the sector PREFIX is the query's first arg, the sequence
    // comes from the cap-checked next_sequence, and the tail is 1A..9F — so the
    // minted coordinate reflects the resolved sector date (plannedFor-wins) instead
    // of a hard-coded value.
    const [sectorPrefix] = (queries[0]?.args ?? []) as [string];
    const sequence = state.nextSequence;
    const logId = `${sectorPrefix}${Math.floor((sequence - 1) / 6) + 1}${"ABCDEF"[(sequence - 1) % 6]}`;
    state.row.status = "distributing";
    state.row.log_id = logId;
    state.row.sequence_number = sequence;
    return [{ rows: [{ log_id: logId, sequence_number: sequence }] }];
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

// A complete, mintable draft. Individual tests blank a field to prove the gate.
// Note: NO external link — distribution supplies it, so the gate no longer requires one.
function seedDraft(overrides: Partial<Row> = {}): void {
  state.nextSequence = 1;
  state.row = {
    created_at: "2026-06-19T00:00:00.000Z",
    duration_ms: 3_480_000,
    id: "draft-id",
    log_id: null,
    member_count: 1,
    note: "A late checkpoint, dreamt.",
    recorded_at: "2026-06-19T00:00:00.000Z",
    sequence_number: null,
    status: "draft",
    title: "",
    updated_at: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("publishMixtape — mint into distributing", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  it("mints a draft into 'distributing' — not yet public — with no external link", async () => {
    seedDraft();

    const minted = await publishMixtape("draft-id");

    expect(minted.status).toBe("distributing");
    expect(minted.logId).toBe("020.F.1A");
  });

  it("mints off the recorded date (the sector day)", async () => {
    seedDraft({ recorded_at: "2026-07-01T20:00:00.000Z" });

    const minted = await publishMixtape("draft-id");

    // The sector is 2026-07-01, the recorded date. (The old plannedFor-wins
    // resolution retired with `mixtapes.planned_for` in the Deploy-2 cutover.)
    expect(minted.logId).toBe("032.F.1A");
  });

  it("canonicalizes the stub title and derives the cover from the minted Log ID", async () => {
    seedDraft();

    const minted = await publishMixtape("draft-id");

    expect(minted.title).toBe("Fluncle Drum & Bass Mixtape #1 | 020.F.1A");
    expect(minted.coverImageUrl).toBe(
      "https://www.fluncle.com/api/mixtape-cover/020.F.1A?size=square&v=2",
    );
  });

  it("treats the DEFAULT stub title as canonicalizable", async () => {
    seedDraft({ title: DEFAULT_MIXTAPE_TITLE });

    const minted = await publishMixtape("draft-id");

    expect(minted.title).toBe("Fluncle Drum & Bass Mixtape #1 | 020.F.1A");
  });

  it("leaves an operator-set (future-series) title untouched, cover still derived", async () => {
    seedDraft({ title: "Fluncle Ambient Mixtape" });

    const minted = await publishMixtape("draft-id");

    expect(minted.title).toBe("Fluncle Ambient Mixtape");
    expect(minted.coverImageUrl).toBe(
      "https://www.fluncle.com/api/mixtape-cover/020.F.1A?size=square&v=2",
    );
  });
});

describe("publishMixtape — mint guards + cap", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  // A draft is just the tracklist — that's the only hard requirement to mint.
  // The recorded date defaults to today, the dream note is written via the
  // post-publish edit, and the duration is derived from the upload by distribute.
  it("mints without a recorded date — it defaults to today", async () => {
    seedDraft({ recorded_at: null });
    await expect(publishMixtape("draft-id")).resolves.toMatchObject({ status: "distributing" });
  });

  it("mints without a note — the dream note is written after publishing", async () => {
    seedDraft({ note: "   " });
    await expect(publishMixtape("draft-id")).resolves.toMatchObject({ status: "distributing" });
  });

  it("mints without a duration — distribution derives it from the upload", async () => {
    seedDraft({ duration_ms: null });
    await expect(publishMixtape("draft-id")).resolves.toMatchObject({ status: "distributing" });
  });

  it("mints even with no external link (distribution supplies it)", async () => {
    seedDraft();
    await expect(publishMixtape("draft-id")).resolves.toMatchObject({ status: "distributing" });
  });

  it("rejects an empty tracklist", async () => {
    seedDraft({ member_count: 0 });
    await expect(publishMixtape("draft-id")).rejects.toThrow(/finding/i);
  });

  it("rejects re-minting a mixtape already distributing", async () => {
    seedDraft({ status: "distributing" });
    await expect(publishMixtape("draft-id")).rejects.toThrow(/in progress/i);
  });

  it("rejects when the spine is full (sequence would exceed 54)", async () => {
    seedDraft();
    state.nextSequence = 55;
    await expect(publishMixtape("draft-id")).rejects.toThrow(/full/i);
  });
});
