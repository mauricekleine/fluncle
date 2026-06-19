import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MIXTAPE_TITLE, publishMixtape } from "./mixtapes";

// publishMixtape's DB choreography: getMixtapeById (a MIXTAPE_SELECT execute) →
// the mint batch (returning log_id + sequence_number) → an optional title/cover
// update execute → getMixtapeByLogId (another MIXTAPE_SELECT execute). We back
// it with a single mutable row and answer each query by its SQL shape — enough
// to prove the canonicalization branch without a real libsql instance.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ row: {} as Row }));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    if (query.sql.includes("update mixtapes set title = ?")) {
      const [title, cover] = query.args as [string, string | null];
      state.row.title = title;
      state.row.cover_image_url = cover;
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

function seedDraft(overrides: Partial<Row> = {}): void {
  state.row = {
    cover_image_url: null,
    created_at: "2026-06-19T00:00:00.000Z",
    id: "draft-id",
    log_id: null,
    recorded_at: "2026-06-19T00:00:00.000Z",
    sequence_number: null,
    status: "draft",
    title: DEFAULT_MIXTAPE_TITLE,
    updated_at: "2026-06-19T00:00:00.000Z",
    youtube_url: "https://youtube.com/watch?v=abc",
    ...overrides,
  };
}

describe("publishMixtape — canonicalization at mint", () => {
  beforeEach(() => {
    execute.mockClear();
    batch.mockClear();
  });

  it("canonicalizes a stub title and fills an empty cover from the minted Log ID", async () => {
    seedDraft();

    const published = await publishMixtape("draft-id");

    expect(published.title).toBe("Fluncle Drum & Bass Mixtape #1 | 020.F.1A");
    expect(published.coverImageUrl).toBe(
      "https://www.fluncle.com/api/mixtape-cover/020.F.1A?size=square",
    );
  });

  it("leaves a custom title and custom cover untouched", async () => {
    seedDraft({
      cover_image_url: "https://example.com/my-cover.png",
      title: "My Special Mixtape",
    });

    const published = await publishMixtape("draft-id");

    expect(published.title).toBe("My Special Mixtape");
    expect(published.coverImageUrl).toBe("https://example.com/my-cover.png");
  });
});
