import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MIXTAPE_TITLE, publishMixtape } from "./mixtapes";

// publishMixtape's DB choreography: getMixtapeById (a MIXTAPE_SELECT execute) →
// the mint batch (returning log_id + sequence_number) → an optional title update
// execute → getMixtapeByLogId (another MIXTAPE_SELECT execute). We back it with a
// single mutable row and answer each query by its SQL shape — enough to prove the
// publish gate + canonicalization without a real libsql instance.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ row: {} as Row }));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    if (query.sql.includes("update mixtapes set title = ?")) {
      const [title] = query.args as [string];
      state.row.title = title;
      return { rows: [] };
    }

    // Both getMixtapeById and getMixtapeByLogId run a MIXTAPE_SELECT; return the
    // current row state (the select projects member_count, default it to 1).
    return { rows: [{ member_count: 1, ...state.row }] };
  }),
);

const batch = vi.hoisted(() =>
  vi.fn(async () => {
    // The mint batch stamps the published coordinate onto the row and returns it.
    state.row.status = "published";
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

// A complete, publishable draft. Individual tests blank a field to prove the gate.
function seedDraft(overrides: Partial<Row> = {}): void {
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
    youtube_url: "https://youtube.com/watch?v=abc",
    ...overrides,
  };
}

describe("publishMixtape — mint + canonicalization", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  it("canonicalizes the stub title and derives the cover from the minted Log ID", async () => {
    seedDraft();

    const published = await publishMixtape("draft-id");

    expect(published.title).toBe("Fluncle Drum & Bass Mixtape #1 | 020.F.1A");
    expect(published.coverImageUrl).toBe(
      "https://www.fluncle.com/api/mixtape-cover/020.F.1A?size=square&v=2",
    );
  });

  it("treats the DEFAULT stub title as canonicalizable", async () => {
    seedDraft({ title: DEFAULT_MIXTAPE_TITLE });

    const published = await publishMixtape("draft-id");

    expect(published.title).toBe("Fluncle Drum & Bass Mixtape #1 | 020.F.1A");
  });

  it("leaves an operator-set (future-series) title untouched, cover still derived", async () => {
    seedDraft({ title: "Fluncle Ambient Mixtape" });

    const published = await publishMixtape("draft-id");

    expect(published.title).toBe("Fluncle Ambient Mixtape");
    expect(published.coverImageUrl).toBe(
      "https://www.fluncle.com/api/mixtape-cover/020.F.1A?size=square&v=2",
    );
  });
});

describe("publishMixtape — required fields", () => {
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

  it("rejects no external link", async () => {
    seedDraft({ youtube_url: null });
    await expect(publishMixtape("draft-id")).rejects.toThrow(/Mixcloud, YouTube, or SoundCloud/i);
  });

  it("rejects an empty tracklist", async () => {
    seedDraft({ member_count: 0 });
    await expect(publishMixtape("draft-id")).rejects.toThrow(/finding/i);
  });
});
