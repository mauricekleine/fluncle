import { beforeEach, describe, expect, it, vi } from "vitest";

// The socials review model (docs/artist-relationship.md): review lands on the LINK, not the
// artist. These tests pin the "Looks good" bulk write (`reviewArtist`); the per-link predicates are
// pinned beside their owner (lib/artist-review.test.ts). The DB is mocked with a SQL-dispatching
// `execute`, so a test never hits a real database.

const execute = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

const { reviewArtist } = await import("./artists");

beforeEach(() => {
  execute.mockReset();
});

describe("reviewArtist", () => {
  it("promotes surviving candidates and bulk-stamps the artist's fresh links reviewed", async () => {
    // First execute = the candidate → confirmed UPDATE (2 rows), second = the reviewed_at stamp.
    execute
      .mockResolvedValueOnce({ rows: [], rowsAffected: 2 })
      .mockResolvedValueOnce({ rows: [], rowsAffected: 3 });

    const result = await reviewArtist("artist-1");

    expect(result).toEqual({ confirmed: 2 });
    expect(execute).toHaveBeenCalledTimes(2);

    const promoteSql = String(execute.mock.calls[0]?.[0].sql);
    expect(promoteSql).toContain("status = 'confirmed'");
    expect(promoteSql).toContain("status = 'candidate'");

    // The stamp lands on the LINKS now (artist_socials.reviewed_at), not on the artist row.
    const stampSql = String(execute.mock.calls[1]?.[0].sql);
    expect(stampSql).toContain("update artist_socials set reviewed_at");
    expect(stampSql).toContain("reviewed_at is null");
    expect(execute.mock.calls[1]?.[0].args).toContain("artist-1");
  });

  it("reports zero promoted when there were no candidates", async () => {
    execute
      .mockResolvedValueOnce({ rows: [], rowsAffected: 0 })
      .mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    expect(await reviewArtist("artist-2")).toEqual({ confirmed: 0 });
  });
});
