import { type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backfillAlbums, DISTINCT_FINDING_ALBUMS_SQL } from "../../../scripts/backfill-album-graph";
import { FINDING_COST_HISTORY_SOURCE_SQL } from "../../../scripts/backfill-cost-history";
import { backfillLabels, DISTINCT_FINDING_LABELS_SQL } from "../../../scripts/backfill-labels";
import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { FINDING_LABEL_CENSUS_SQL } from "./labels";
import { FINDING_MATCH_CORPUS_SQL } from "./recordings";

const FINDING_BOUNDED_READS: readonly (readonly [string, string])[] = [
  ["album graph mint", DISTINCT_FINDING_ALBUMS_SQL],
  ["cost-history source", FINDING_COST_HISTORY_SOURCE_SQL],
  ["label graph mint", DISTINCT_FINDING_LABELS_SQL],
  ["runtime label reconciliation", FINDING_LABEL_CENSUS_SQL],
  ["recording text-match corpus", FINDING_MATCH_CORPUS_SQL],
];

let db: Client;

async function planFor(sql: string): Promise<string[]> {
  const result = await db.execute(`explain query plan ${sql}`);

  return (result.rows as unknown as { detail: string }[]).map((row) => row.detail);
}

describe("finding-bounded certified-corpus reads", () => {
  beforeAll(async () => {
    db = await createIntegrationDb();
  });

  afterAll(() => {
    db.close();
  });

  it.each(FINDING_BOUNDED_READS)("%s scans findings and seeks tracks", async (_name, sql) => {
    const plan = await planFor(sql);

    expect(plan.some((detail) => /^SCAN findings\b/.test(detail))).toBe(true);
    expect(plan.some((detail) => /^SEARCH tracks\b/.test(detail))).toBe(true);
    expect(plan.some((detail) => /^SCAN tracks\b/.test(detail))).toBe(false);
  });

  it("mints graph entities only from certified tracks", async () => {
    await seedTrack(db, {
      label: "Certified Label",
      logId: "001.1.1A",
      trackId: "certified",
    });
    await seedCatalogueTrack(db, {
      label: "Catalogue Label",
      trackId: "catalogue",
    });
    await db.batch(
      [
        {
          args: ["Certified Album", "certified"],
          sql: `update tracks set album = ? where track_id = ?`,
        },
        {
          args: ["Catalogue Album", "catalogue"],
          sql: `update tracks set album = ? where track_id = ?`,
        },
      ],
      "write",
    );

    await backfillLabels(db);
    await backfillAlbums(db);

    const labels = await db.execute(`select name from labels order by name`);
    const albums = await db.execute(`select name from albums order by name`);

    expect(labels.rows.map((row) => row.name)).toEqual(["Certified Label"]);
    expect(albums.rows.map((row) => row.name)).toEqual(["Certified Album"]);
  });
});
