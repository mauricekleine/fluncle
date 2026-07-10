import { galaxySlug } from "@fluncle/contracts/util/galaxy-slug";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateGalaxyMap } from "./galaxies-map";

// updateGalaxyMap (the browse-by-feel cluster cron's transactional map write) is
// answered by SQL shape — enough to prove the server-side identity mint (a `gal_<uuid>`
// id + a collision-salted `galaxySlug` handle), the collision salt itself, and the ONE
// `db.batch(_, "write")` transaction (insert new / upsert centroid / retire), without a
// real libsql instance. `randomUUID` is pinned so the minted id — and thus the handle
// the salt loop derives — is deterministic.

const FIXED_UUID = "0000-fixed-uuid";
const NEW_ID = `gal_${FIXED_UUID}`;

vi.mock("node:crypto", () => ({ randomUUID: () => FIXED_UUID }));

const execute = vi.hoisted(() => vi.fn());
const batch = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ batch, execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

// The `select handle from galaxies` pre-read — the handles the salt loop avoids. Set
// per test so a seeded collision forces `galaxySlug(id, 1)`.
let takenHandles: Array<{ handle: string }> = [];

beforeEach(() => {
  execute.mockReset();
  batch.mockReset();
  takenHandles = [];

  execute.mockImplementation((query: string | { sql: string }) => {
    const sql = typeof query === "string" ? query : query.sql;

    if (sql.includes("select handle from galaxies")) {
      return Promise.resolve({ rows: takenHandles });
    }

    if (sql.includes("count(*)")) {
      // memberCounts (the final listGalaxiesAdmin read) — no members in these tests.
      return Promise.resolve({ rows: [] });
    }

    // The final listGalaxiesAdmin `select ... from galaxies order by ...` — return the
    // freshly-minted row so the op has something to echo back.
    return Promise.resolve({
      rows: [
        {
          centroid_json: "[0.1,0.2]",
          created_at: "2026-07-10T00:00:00.000Z",
          handle: "liquid-nebula-roller",
          id: NEW_ID,
          name: null,
          retired_at: null,
          slug: null,
          split_requested_at: null,
          updated_at: "2026-07-10T00:00:00.000Z",
        },
      ],
    });
  });

  batch.mockResolvedValue(undefined);
});

describe("updateGalaxyMap — server-side identity mint", () => {
  it("mints a gal_<uuid> id + a galaxySlug handle for a new (id: null) cluster", async () => {
    await updateGalaxyMap([{ centroid: [0.1, 0.2], id: null }]);

    expect(batch).toHaveBeenCalledTimes(1);
    const [statements, mode] = batch.mock.calls[0] as [
      Array<{ args: unknown[]; sql: string }>,
      string,
    ];

    expect(mode).toBe("write");
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("insert into galaxies");
    // args: [id, handle, centroid_json, now, now]
    expect(statements[0].args[0]).toBe(NEW_ID);
    expect(statements[0].args[1]).toBe(galaxySlug(NEW_ID, 0));
  });

  it("salts the handle past a collision (galaxySlug attempt 0 taken → attempt 1)", async () => {
    // Seed the taken set with exactly what attempt 0 would mint, forcing the salt loop.
    takenHandles = [{ handle: galaxySlug(NEW_ID, 0) }];

    await updateGalaxyMap([{ centroid: [0.3], id: null }]);

    const [statements] = batch.mock.calls[0] as [Array<{ args: unknown[]; sql: string }>, string];

    expect(statements[0].args[1]).toBe(galaxySlug(NEW_ID, 1));
    expect(statements[0].args[1]).not.toBe(galaxySlug(NEW_ID, 0));
  });
});

describe("updateGalaxyMap — the batch write shapes", () => {
  it("upserts an existing centroid, retires a flagged row, and inserts a new one — one transaction", async () => {
    await updateGalaxyMap([
      { centroid: [1], id: "gal_existing" },
      { centroid: [2], id: "gal_dying", retire: true },
      { centroid: [3], id: null },
    ]);

    expect(batch).toHaveBeenCalledTimes(1);
    const [statements, mode] = batch.mock.calls[0] as [
      Array<{ args: unknown[]; sql: string }>,
      string,
    ];

    expect(mode).toBe("write");
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain("set centroid_json = ?");
    expect(statements[1].sql).toContain("set retired_at = ?");
    expect(statements[2].sql).toContain("insert into galaxies");
  });

  it("does not open a transaction when there are no clusters", async () => {
    await updateGalaxyMap([]);

    expect(batch).not.toHaveBeenCalled();
  });
});
