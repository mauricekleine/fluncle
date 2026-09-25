import { type Client } from "@libsql/client";

import { beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack } from "../src/lib/server/integration-db";
import {
  initializePublicProjectionTestState,
  readPublicProjectionMaintenanceSnapshot,
  settlePublicProjectionTestState,
} from "./lib/public-projection-test-state";
import { backfillHasEmbedding } from "./backfill-has-embedding";

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

  await db.execute({
    args: [JSON.stringify(Array.from({ length: 1024 }, () => 0.01))],
    sql: `insert into track_embeddings (track_id, embedding_blob)
          values ('emb000000000000000000a', vector32(?))`,
  });
  await db.execute("update tracks set has_embedding = 0");
});

describe("backfillHasEmbedding", () => {
  it("flips a row carrying a vector to 1, leaves a bare row at 0", async () => {
    expect(await mirror("emb000000000000000000a")).toBe(0);
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
    await db.execute(
      "update tracks set has_embedding = 1 where track_id = 'bare00000000000000000a'",
    );

    const { flipped } = await backfillHasEmbedding(db);

    expect(flipped).toBe(2);
    expect(await mirror("emb000000000000000000a")).toBe(1);
    expect(await mirror("bare00000000000000000a")).toBe(0);
  });
});
