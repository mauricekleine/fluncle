// THE FINDINGS-DRIVER CONTRACT, pinned by query plan.
//
// A census of the certified archive is bounded by `findings` — tens of rows — but only if the
// planner enters the join from that side. Hosted Turso cannot run `ANALYZE`
// (docs/db-scale-backlog.md § the vector satellite), so `sqlite_stat1` does not exist and the
// planner has no way to learn that `findings` is the small table: spelled as a plain `join` it
// picks `tracks` as the outer loop and probes `findings` once per row, turning an archive-sized
// question into a full scan of the table the crawler grows every ten minutes. `catalogue.ts`'s
// `FINDING_QUALIFIED_ARTISTS_SQL` states the law and its cost in full; SQLite treats CROSS JOIN as
// "do not reorder", which is what holds the driver in place.
//
// Nothing about the RESULT changes between the two spellings, so no behavioural test can catch a
// regression here — only the plan can. Each statement below is exported from its module for
// exactly that reason.
import { type Client } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";

import { DISTINCT_FINDING_ALBUMS_SQL } from "../../../scripts/backfill-album-graph";
import { DISTINCT_FINDING_LABELS_SQL } from "../../../scripts/backfill-labels";
import { createIntegrationDb } from "./integration-db";
import { FINDING_LABEL_CENSUS_SQL } from "./labels";
import { FINDING_MATCH_CORPUS_SQL } from "./recordings";

const CENSUSES: readonly (readonly [string, string])[] = [
  ["labels.ts reconcileLabels", FINDING_LABEL_CENSUS_SQL],
  ["recordings.ts resolveFindingIdsByText", FINDING_MATCH_CORPUS_SQL],
  ["scripts/backfill-labels.ts reconcile", DISTINCT_FINDING_LABELS_SQL],
  ["scripts/backfill-album-graph.ts mint", DISTINCT_FINDING_ALBUMS_SQL],
];

let db: Client;

async function planFor(sql: string): Promise<string[]> {
  const result = await db.execute(`explain query plan ${sql}`);

  return (result.rows as unknown as { detail: string }[]).map((row) => row.detail);
}

describe("finding-bounded censuses drive from findings", () => {
  beforeAll(async () => {
    db = await createIntegrationDb();
  });

  it.each(CENSUSES)("%s enters the join from findings, never from tracks", async (_name, sql) => {
    const plan = await planFor(sql);

    expect(plan.some((step) => /^SCAN findings\b/.test(step))).toBe(true);
    expect(plan.some((step) => /^SCAN tracks\b/.test(step))).toBe(false);
    expect(plan.some((step) => /^SEARCH tracks\b/.test(step))).toBe(true);
  });

  it("still says SCAN tracks when the CROSS JOIN is downgraded to a plain join", async () => {
    // The guard above is only worth having if it bites, and the two spellings differ by one word.
    const downgraded = FINDING_LABEL_CENSUS_SQL.replace("cross join", "join");
    const plan = await planFor(downgraded);

    expect(downgraded).not.toBe(FINDING_LABEL_CENSUS_SQL);
    expect(plan.some((step) => /^SCAN tracks\b/.test(step))).toBe(true);
  });
});
