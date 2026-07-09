import { beforeEach, describe, expect, it, vi } from "vitest";

// The socials review model (docs/admin-shell.md, ratified 2026-07-08): "needs a look" is a
// single per-artist acknowledgment off `reviewed_at` vs each link's `created_at`. These tests
// pin the pure predicate + the "Looks good" write it rests on (`reviewArtist`). The DB is
// mocked with a SQL-dispatching `execute`, so a test never hits a real database.

const execute = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

const { artistNeedsLook, reviewArtist } = await import("./artists");

beforeEach(() => {
  execute.mockReset();
});

describe("artistNeedsLook", () => {
  const social = (createdAt: string) => ({ createdAt });

  it("is false when the artist has no links (nothing to look at)", () => {
    expect(artistNeedsLook(null, [])).toBe(false);
    expect(artistNeedsLook("2026-07-08T00:00:00.000Z", [])).toBe(false);
  });

  it("is true when a link exists but the list was never reviewed", () => {
    expect(artistNeedsLook(null, [social("2026-07-01T00:00:00.000Z")])).toBe(true);
  });

  it("is false when every link was discovered at or before the last review", () => {
    const reviewedAt = "2026-07-08T12:00:00.000Z";
    expect(
      artistNeedsLook(reviewedAt, [
        social("2026-07-01T00:00:00.000Z"),
        social("2026-07-08T12:00:00.000Z"),
      ]),
    ).toBe(false);
  });

  it("re-arms when a link is discovered AFTER the last review", () => {
    const reviewedAt = "2026-07-08T12:00:00.000Z";
    expect(
      artistNeedsLook(reviewedAt, [
        social("2026-07-01T00:00:00.000Z"), // seen
        social("2026-07-09T09:00:00.000Z"), // new since review
      ]),
    ).toBe(true);
  });
});

describe("reviewArtist", () => {
  it("promotes surviving candidates and stamps the artist reviewed", async () => {
    // First execute = the candidate → confirmed UPDATE (2 rows), second = the reviewed_at stamp.
    execute
      .mockResolvedValueOnce({ rows: [], rowsAffected: 2 })
      .mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    const result = await reviewArtist("artist-1");

    expect(result).toEqual({ confirmed: 2 });
    expect(execute).toHaveBeenCalledTimes(2);

    const promoteSql = String(execute.mock.calls[0]?.[0].sql);
    expect(promoteSql).toContain("status = 'confirmed'");
    expect(promoteSql).toContain("status = 'candidate'");

    const stampSql = String(execute.mock.calls[1]?.[0].sql);
    expect(stampSql).toContain("update artists set reviewed_at");
    expect(execute.mock.calls[1]?.[0].args).toContain("artist-1");
  });

  it("reports zero promoted when there were no candidates", async () => {
    execute
      .mockResolvedValueOnce({ rows: [], rowsAffected: 0 })
      .mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    expect(await reviewArtist("artist-2")).toEqual({ confirmed: 0 });
  });
});
