import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const projectionMaintenance = (sql: string) =>
  sql.includes("insert into due_work") ||
  sql.includes("public_aggregate_state") ||
  sql.includes("artist_qualification_state") ||
  sql.includes("projection_repairs");

vi.mock("./db", () => ({
  getDb: async () => ({
    batch: (statements: { args?: unknown[]; sql: string }[]) =>
      Promise.all(
        statements.map((statement) =>
          projectionMaintenance(statement.sql)
            ? Promise.resolve({ rows: [], rowsAffected: 1 })
            : execute(statement),
        ),
      ),
    execute,
  }),
  typedRows: (rows: unknown) => rows,
}));

const { mintArtistByMbid } = await import("./artists");

const uniqueSlugError = () =>
  new Error("SQLITE_CONSTRAINT: SQLite error: UNIQUE constraint failed: artists.slug");

beforeEach(() => {
  execute.mockReset();
});

describe("mintArtistByMbid slug-race recovery", () => {
  it("mints normally when the slug probe and insert do not race", async () => {
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    const id = await mintArtistByMbid("Alix Perez", "mbid-1");

    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("ADOPTS the race twin's row when the winner carries the same mbid (never a salted duplicate)", async () => {
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(uniqueSlugError())
      .mockResolvedValueOnce({ rows: [{ id: "existing-artist-id" }] });

    const id = await mintArtistByMbid("Alix Perez", "mbid-1");

    expect(id).toBe("existing-artist-id");

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("re-probes and retries when the slug holder is a DIFFERENT artist (no mbid match)", async () => {
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(uniqueSlugError())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const id = await mintArtistByMbid("Alix Perez", "mbid-2");

    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("rethrows a non-slug error untouched", async () => {
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"));

    await expect(mintArtistByMbid("Alix Perez", "mbid-3")).rejects.toThrow("SQLITE_BUSY");
  });
});
