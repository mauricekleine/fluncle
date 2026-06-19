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
  vi.fn(async () => {
    // The mint batch stamps the minted coordinate onto the row (status →
    // 'distributing', NOT 'published' — the first platform link publishes it later).
    state.row.status = "distributing";
    state.row.log_id = "020.F.1A";
    state.row.sequence_number = 1;
    return [{ rows: [{ log_id: "020.F.1A", sequence_number: 1 }] }];
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

describe("publishMixtape — required fields + cap", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  it("rejects a missing recorded date", async () => {
    seedDraft({ recorded_at: null });
    await expect(publishMixtape("draft-id")).rejects.toThrow(/recorded date/i);
  });

  it("rejects a missing note", async () => {
    seedDraft({ note: "   " });
    await expect(publishMixtape("draft-id")).rejects.toThrow(/note/i);
  });

  it("rejects a missing duration", async () => {
    seedDraft({ duration_ms: null });
    await expect(publishMixtape("draft-id")).rejects.toThrow(/duration/i);
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
