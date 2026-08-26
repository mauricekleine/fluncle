// The mbid mint's slug-race recovery (FLUNCLE-WORKER-13): `mintArtistSlug` is check-then-insert,
// so a concurrent writer can claim the probed slug between the probe and the insert. On the UNIQUE
// violation the mint must (a) ADOPT the race twin's row when it carries the SAME mbid — salting
// there would mint a split-identity duplicate — and (b) re-probe + retry only for a genuinely
// different artist sharing the name-fold. Mocked `./db` in the labels.test.ts style: each test
// scripts the exact statement sequence the path issues.
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
    execute
      .mockResolvedValueOnce({ rows: [] }) // slug probe: base is free
      .mockResolvedValueOnce({ rows: [] }); // insert succeeds

    const id = await mintArtistByMbid("Alix Perez", "mbid-1");

    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("ADOPTS the race twin's row when the winner carries the same mbid (never a salted duplicate)", async () => {
    execute
      .mockResolvedValueOnce({ rows: [] }) // slug probe: base looks free
      .mockRejectedValueOnce(uniqueSlugError()) // insert loses the race
      .mockResolvedValueOnce({ rows: [{ id: "existing-artist-id" }] }); // mbid re-check finds the twin

    const id = await mintArtistByMbid("Alix Perez", "mbid-1");

    expect(id).toBe("existing-artist-id");
    // No second insert: the twin's row IS this artist.
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("re-probes and retries when the slug holder is a DIFFERENT artist (no mbid match)", async () => {
    execute
      .mockResolvedValueOnce({ rows: [] }) // probe: base looks free
      .mockRejectedValueOnce(uniqueSlugError()) // insert loses the race
      .mockResolvedValueOnce({ rows: [] }) // mbid re-check: not the same artist
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] }) // re-probe: base now taken by the winner
      .mockResolvedValueOnce({ rows: [] }) // re-probe: base-2 free
      .mockResolvedValueOnce({ rows: [] }); // retry insert succeeds

    const id = await mintArtistByMbid("Alix Perez", "mbid-2");

    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("rethrows a non-slug error untouched", async () => {
    execute
      .mockResolvedValueOnce({ rows: [] }) // probe
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked")); // a different failure

    await expect(mintArtistByMbid("Alix Perez", "mbid-3")).rejects.toThrow("SQLITE_BUSY");
  });
});
