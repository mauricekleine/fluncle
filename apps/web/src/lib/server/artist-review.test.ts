import { beforeEach, describe, expect, it, vi } from "vitest";

// The socials review model (docs/artist-relationship.md): review lands on the LINK, not the
// artist. "Needs a look" is now a per-link fact — a link is fresh iff its `reviewedAt` is null.
// These tests pin the pure predicates (`artistNeedsLook`, `unreviewedSocials`) + the "Looks good"
// bulk write (`reviewArtist`). The DB is mocked with a SQL-dispatching `execute`, so a test never
// hits a real database.

const execute = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

const { artistNeedsLook, reviewArtist, unreviewedSocials } = await import("./artists");

beforeEach(() => {
  execute.mockReset();
});

describe("artistNeedsLook", () => {
  const link = (reviewedAt: string | null) => ({ reviewedAt });

  it("is false when the artist has no links (nothing to look at)", () => {
    expect(artistNeedsLook([])).toBe(false);
  });

  it("is false when every link has been reviewed", () => {
    expect(
      artistNeedsLook([link("2026-07-01T00:00:00.000Z"), link("2026-07-08T12:00:00.000Z")]),
    ).toBe(false);
  });

  it("is true when any link is still unreviewed (reviewedAt null)", () => {
    expect(artistNeedsLook([link("2026-07-01T00:00:00.000Z"), link(null)])).toBe(true);
  });
});

describe("unreviewedSocials", () => {
  it("returns only the unreviewed links, oldest-first", () => {
    const fresh = { createdAt: "2026-07-05T00:00:00.000Z", id: "b", reviewedAt: null };
    const alsoFresh = { createdAt: "2026-07-01T00:00:00.000Z", id: "a", reviewedAt: null };
    const seen = { createdAt: "2026-07-09T00:00:00.000Z", id: "c", reviewedAt: "2026-07-09" };

    expect(unreviewedSocials([fresh, alsoFresh, seen])).toEqual([alsoFresh, fresh]);
  });

  it("is empty when nothing is fresh", () => {
    expect(
      unreviewedSocials([
        { createdAt: "2026-07-01T00:00:00.000Z", id: "a", reviewedAt: "2026-07-02" },
      ]),
    ).toEqual([]);
  });
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
