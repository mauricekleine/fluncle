import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MIXTAPE_TITLE, publishMixtape } from "./mixtapes";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ nextSequence: 1, row: {} as Row }));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    if (query.sql.includes("update mixtapes set title = ?")) {
      const [title] = query.args as [string];
      state.row.title = title;
      return { rows: [] };
    }

    if (query.sql.includes("coalesce(max(sequence_number), 0) + 1")) {
      return { rows: [{ n: state.nextSequence }] };
    }

    return { rows: [{ member_count: 1, ...state.row }] };
  }),
);

const batch = vi.hoisted(() =>
  vi.fn(async (queries: Array<{ args: unknown[] }>) => {
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

function seedClaim(overrides: Partial<Row> = {}): void {
  state.nextSequence = 1;
  state.row = {
    created_at: "2026-06-19T00:00:00.000Z",
    duration_ms: 3_480_000,
    id: "claim-id",
    log_id: null,
    member_count: 1,
    note: "A late checkpoint, dreamt.",
    recorded_at: "2026-06-19T00:00:00.000Z",
    sequence_number: null,
    status: "distributing",
    title: "",
    updated_at: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("publishMixtape — mint the claimed coordinate", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  it("mints an unminted claim — committing its Log ID, not yet public", async () => {
    seedClaim();

    const minted = await publishMixtape("claim-id");

    expect(minted.status).toBe("distributing");
    expect(minted.logId).toBe("020.F.1A");
  });

  it("mints off the recorded date (the sector day)", async () => {
    seedClaim({ recorded_at: "2026-07-01T20:00:00.000Z" });

    const minted = await publishMixtape("claim-id");

    expect(minted.logId).toBe("032.F.1A");
  });

  it("canonicalizes the stub title and derives the cover from the minted Log ID", async () => {
    seedClaim();

    const minted = await publishMixtape("claim-id");

    expect(minted.title).toBe("Fluncle Drum & Bass Mixtape #1 | 020.F.1A");
    expect(minted.coverImageUrl).toBe(
      "https://www.fluncle.com/api/mixtape-cover/020.F.1A?size=square&v=2",
    );
  });

  it("treats the DEFAULT stub title as canonicalizable", async () => {
    seedClaim({ title: DEFAULT_MIXTAPE_TITLE });

    const minted = await publishMixtape("claim-id");

    expect(minted.title).toBe("Fluncle Drum & Bass Mixtape #1 | 020.F.1A");
  });

  it("leaves an operator-set (future-series) title untouched, cover still derived", async () => {
    seedClaim({ title: "Fluncle Ambient Mixtape" });

    const minted = await publishMixtape("claim-id");

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

  it("mints without a recorded date — it defaults to today", async () => {
    seedClaim({ recorded_at: null });
    await expect(publishMixtape("claim-id")).resolves.toMatchObject({ status: "distributing" });
  });

  it("mints without a note — the dream note is written after publishing", async () => {
    seedClaim({ note: "   " });
    await expect(publishMixtape("claim-id")).resolves.toMatchObject({ status: "distributing" });
  });

  it("mints without a duration — distribution derives it from the upload", async () => {
    seedClaim({ duration_ms: null });
    await expect(publishMixtape("claim-id")).resolves.toMatchObject({ status: "distributing" });
  });

  it("mints even with no external link (distribution supplies it)", async () => {
    seedClaim();
    await expect(publishMixtape("claim-id")).resolves.toMatchObject({ status: "distributing" });
  });

  it("rejects an empty tracklist", async () => {
    seedClaim({ member_count: 0 });
    await expect(publishMixtape("claim-id")).rejects.toThrow(/finding/i);
  });

  it("rejects re-minting a mixtape whose coordinate is already committed", async () => {
    seedClaim({ log_id: "020.F.1A", sequence_number: 1 });
    await expect(publishMixtape("claim-id")).rejects.toThrow(/in progress/i);
  });

  it("rejects re-minting a published mixtape", async () => {
    seedClaim({ log_id: "020.F.1A", sequence_number: 1, status: "published" });
    await expect(publishMixtape("claim-id")).rejects.toThrow(/keep their coordinate/i);
  });

  it("rejects when the spine is full (sequence would exceed 54)", async () => {
    seedClaim();
    state.nextSequence = 55;
    await expect(publishMixtape("claim-id")).rejects.toThrow(/full/i);
  });
});
