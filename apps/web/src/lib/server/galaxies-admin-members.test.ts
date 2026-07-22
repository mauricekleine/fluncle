import { type TrackListItem } from "@fluncle/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listGalaxiesAdminWithMembers } from "./galaxies-map";

// listGalaxiesAdminWithMembers (the `/admin/galaxies` naming view's read, Slice 3) attaches
// each galaxy's capped, core-first member sample to the full admin map. Proven by SQL shape:
// the galaxies select + the derived member-count query (mocked `./db`), and the ranked
// member read (mocked `./tracks` `getGalaxyAuditionMembers` — the LEAN board-projection
// hydration the audition uses, distinct from the fat public `getFindingsByGalaxyRanked`) — so
// the composition is verified without a real libsql instance or embedding math.

const execute = vi.hoisted(() => vi.fn());
const getGalaxyAuditionMembers = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

vi.mock("./tracks", () => ({
  // Unused by this function but imported by the module under test.
  getFindingsByGalaxyRanked: vi.fn(),
  getGalaxyAuditionMembers,
  toPublicTrackListItem: <T extends object>(item: T) => item,
}));

const member = (logId: string): TrackListItem =>
  ({ artists: ["Someone"], logId, title: `Track ${logId}` }) as TrackListItem;

function galaxyRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    centroid_json: "[0.1,0.2]",
    created_at: "2026-07-10T00:00:00.000Z",
    handle: "liquid-nebula-roller",
    id: "gal_a",
    name: null,
    retired_at: null,
    slug: null,
    split_requested_at: null,
    updated_at: "2026-07-10T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  execute.mockReset();
  getGalaxyAuditionMembers.mockReset();
});

describe("listGalaxiesAdminWithMembers", () => {
  it("returns an empty array when the map has no galaxies", async () => {
    execute.mockImplementation((query: string | { sql: string }) => {
      const sql = typeof query === "string" ? query : query.sql;
      return Promise.resolve({ rows: sql.includes("count(*)") ? [] : [] });
    });

    const result = await listGalaxiesAdminWithMembers(24);

    expect(result).toEqual([]);
    expect(getGalaxyAuditionMembers).not.toHaveBeenCalled();
  });

  it("attaches each galaxy's ranked members and passes the cap + centroid through", async () => {
    execute.mockImplementation((query: string | { sql: string }) => {
      const sql = typeof query === "string" ? query : query.sql;

      if (sql.includes("count(*)")) {
        // Derived member counts: gal_a has 3 (uncapped total), gal_b has 1.
        return Promise.resolve({
          rows: [
            { c: 3, galaxy_id: "gal_a" },
            { c: 1, galaxy_id: "gal_b" },
          ],
        });
      }

      return Promise.resolve({
        rows: [
          galaxyRow({ centroid_json: "[0.1,0.2]", id: "gal_a" }),
          galaxyRow({ centroid_json: "[0.9,0.8]", id: "gal_b" }),
        ],
      });
    });

    getGalaxyAuditionMembers.mockImplementation((galaxyId: string) =>
      Promise.resolve(galaxyId === "gal_a" ? [member("a1"), member("a2")] : [member("b1")]),
    );

    const result = await listGalaxiesAdminWithMembers(24);

    expect(result).toHaveLength(2);
    // The cap + the parsed centroid + offset 0 reach the ranked read.
    expect(getGalaxyAuditionMembers).toHaveBeenCalledWith("gal_a", [0.1, 0.2], 24, 0);
    expect(getGalaxyAuditionMembers).toHaveBeenCalledWith("gal_b", [0.9, 0.8], 24, 0);

    const galA = result.find((entry) => entry.id === "gal_a");
    expect(galA?.members.map((entry) => entry.logId)).toEqual(["a1", "a2"]);
    // memberCount stays the true (uncapped) total, independent of the shown sample.
    expect(galA?.memberCount).toBe(3);

    const galB = result.find((entry) => entry.id === "gal_b");
    expect(galB?.members.map((entry) => entry.logId)).toEqual(["b1"]);
    expect(galB?.memberCount).toBe(1);
  });
});
