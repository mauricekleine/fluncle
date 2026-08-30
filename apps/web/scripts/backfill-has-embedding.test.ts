import { type Client } from "@libsql/client";

import { beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack } from "../src/lib/server/integration-db";
import {
  initializePublicProjectionTestState,
  readPublicProjectionMaintenanceSnapshot,
  settlePublicProjectionTestState,
} from "./lib/public-projection-test-state";
import { backfillHasEmbedding } from "./backfill-has-embedding";

// The `has_embedding` backfill (docs/db-scale-backlog Wave 2 #4, built for #7): the migration adds
// the column DEFAULT 0, so every EXISTING row lands un-embedded — wrong for every row carrying a
// vector. This flips exactly those, and only those. Driven against the real migrated schema so the
// SQL under test is byte-identical to production.
//
// WHAT IT MIRRORS is a `track_embeddings` row, not a `tracks` column, so every fixture below
// writes the satellite directly — RAW, deliberately bypassing the paired write, because an
// unpaired vector is exactly the state history and a restored backup leave behind and exactly what
// this pass exists to heal.

let db: Client;

async function mirror(trackId: string): Promise<number> {
  const result = await db.execute({
    args: [trackId],
    sql: "select has_embedding from tracks where track_id = ?",
  });

  return Number(result.rows[0]?.has_embedding);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await initializePublicProjectionTestState(db);
  await seedCatalogueTrack(db, { title: "Embedded", trackId: "emb000000000000000000a" });
  await seedCatalogueTrack(db, { title: "Bare", trackId: "bare00000000000000000a" });
  // Recreate the pre-backfill state the migration leaves behind: a row that HAS a vector but whose
  // mirror still reads the DDL default.
  await db.execute({
    args: [JSON.stringify(Array.from({ length: 1024 }, () => 0.01))],
    sql: `insert into track_embeddings (track_id, embedding_blob)
          values ('emb000000000000000000a', vector32(?))`,
  });
  await db.execute("update tracks set has_embedding = 0");
});

describe("backfillHasEmbedding", () => {
  it("flips a row carrying a vector to 1, leaves a bare row at 0", async () => {
    expect(await mirror("emb000000000000000000a")).toBe(0); // pre-backfill: the migration's default
    expect(await mirror("bare00000000000000000a")).toBe(0);

    const { flipped } = await backfillHasEmbedding(db);

    expect(flipped).toBe(1);
    expect(await mirror("emb000000000000000000a")).toBe(1);
    expect(await mirror("bare00000000000000000a")).toBe(0);
    const markers = await db.execute({
      sql: `select subject_id from due_work where work_kind = 'source-repair'
            order by subject_id`,
    });
    expect(markers.rows.map((row) => row.subject_id)).toEqual([
      "@catalogue-rank-corpus",
      "emb000000000000000000a",
    ]);
  });

  it("is idempotent — a second run flips nothing and changes no state", async () => {
    await backfillHasEmbedding(db);
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      repairs: [],
    });
    await settlePublicProjectionTestState(db);
    const ready = await readPublicProjectionMaintenanceSnapshot(db);
    expect(ready).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      repairs: [],
    });
    const { flipped } = await backfillHasEmbedding(db);

    expect(flipped).toBe(0);
    expect(await mirror("emb000000000000000000a")).toBe(1);
    expect(await mirror("bare00000000000000000a")).toBe(0);
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual(ready);
  });

  it("corrects drift in BOTH directions in one pass", async () => {
    // The complement of the seeding case, and the reason the predicate reconciles against the
    // vectors rather than only flipping 0 → 1: a row FLAGGED with no vector (a console
    // `DELETE FROM track_embeddings`, a restored backup) makes the funnel OVER-report AND hides
    // the row from the re-embed queue, and no write site is left to fix it.
    await db.execute(
      "update tracks set has_embedding = 1 where track_id = 'bare00000000000000000a'",
    );

    const { flipped } = await backfillHasEmbedding(db);

    expect(flipped).toBe(2); // the un-flagged embedded row AND the flagged bare one
    expect(await mirror("emb000000000000000000a")).toBe(1);
    expect(await mirror("bare00000000000000000a")).toBe(0);
  });
});
