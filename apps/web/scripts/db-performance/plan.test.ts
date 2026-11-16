import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeExplainPlan, type ExplainPlanPolicy } from "./plan";

const policy: ExplainPlanPolicy = {
  accessPaths: [
    {
      minimumSearches: 2,
      paths: [
        { equalityPrefix: ["track_id"], index: "sqlite_autoindex_tracks_1" },
        {
          equalityPrefix: ["is_catalogue", "dismissed_at", "track_id"],
          index: "tracks_catalogue_active_track_id_idx",
        },
      ],
      table: "tracks",
    },
  ],
  growingTables: ["tracks"],
};
const hydration = "SEARCH tracks USING INDEX sqlite_autoindex_tracks_1 (track_id=?)";

describe("indexed access-path contracts", () => {
  it("accepts selective paths across harmless planner spelling changes", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ max: 4, min: 1 }),
        fc.integer({ max: 3, min: 0 }),
        (covering, tableWord, spaces, quote) => {
          const q = (name: string) =>
            [name, `"${name}"`, `[${name}]`, `\`${name}\``][quote] ?? name;
          const detail =
            `SEARCH ${tableWord ? "TABLE " : ""}${q("tracks")} USING ${covering ? "COVERING " : ""}INDEX ${q("sqlite_autoindex_tracks_1")} (${q("track_id")} = ?) LEFT-JOIN`.replaceAll(
              " ",
              " ".repeat(spaces),
            );
          for (const variant of [detail, detail.toLowerCase()]) {
            expect(analyzeExplainPlan([variant, hydration], policy).violations).toEqual([]);
          }
        },
      ),
      { numRuns: 100, seed: 19121910 },
    );
  });

  it.each([
    "SEARCH tracks USING COVERING INDEX tracks_sitemap_indexable_cover_idx (duplicate_of_track_id=? AND dismissed_at=?)",
    "SEARCH tracks USING INDEX tracks_catalogue_active_track_id_idx (is_catalogue=? AND dismissed_at=?)",
    "SEARCH tracks USING INDEX sqlite_autoindex_tracks_1 (track_id>?)",
    "SEARCH tracks USING AUTOMATIC COVERING INDEX (dismissed_at=?)",
    "SCAN tracks USING COVERING INDEX tracks_sitemap_indexable_cover_idx",
  ])("rejects broad access alongside a valid hydration seek: %s", (detail) => {
    expect(analyzeExplainPlan([detail, hydration], policy).violations.length).toBeGreaterThan(0);
  });

  it("accepts an alternative index only when the track-id equality completes its prefix", () => {
    expect(
      analyzeExplainPlan(
        [
          "SEARCH tracks USING INDEX tracks_catalogue_active_track_id_idx (is_catalogue=? AND dismissed_at=? AND track_id=?)",
          hydration,
        ],
        policy,
      ).violations,
    ).toEqual([]);
    expect(analyzeExplainPlan([hydration], policy).violations).toContain(
      "required indexed search of tracks was absent",
    );
  });
});
