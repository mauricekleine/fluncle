import { type Client } from "@libsql/client";

import { beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack } from "../src/lib/server/integration-db";
import { backfillHasEmbedding } from "./backfill-has-embedding";

// The `has_embedding` backfill (docs/db-scale-backlog Wave 2 #4, built for #7): the migration adds
// the column DEFAULT 0, so every EXISTING row lands un-embedded — wrong for every row carrying a
// vector. This flips exactly those, and only those. Driven against the real migrated schema so the
// SQL under test is byte-identical to production.

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
  await seedCatalogueTrack(db, { title: "Embedded", trackId: "emb000000000000000000a" });
  await seedCatalogueTrack(db, { title: "Bare", trackId: "bare00000000000000000a" });
  // Recreate the pre-backfill state the migration leaves behind: a row that HAS a vector but whose
  // mirror still reads the DDL default. Written raw, deliberately bypassing the paired write sites,
  // because that unpaired state is exactly what history looks like and what the backfill must heal.
  await db.execute({
    args: [JSON.stringify(Array.from({ length: 1024 }, () => 0.01))],
    sql: "update tracks set embedding_blob = vector32(?) where track_id = 'emb000000000000000000a'",
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
  });

  it("is idempotent — a second run flips nothing and changes no state", async () => {
    await backfillHasEmbedding(db);
    const { flipped } = await backfillHasEmbedding(db);

    expect(flipped).toBe(0);
    expect(await mirror("emb000000000000000000a")).toBe(1);
    expect(await mirror("bare00000000000000000a")).toBe(0);
  });

  it("corrects drift in BOTH directions in one pass", async () => {
    // The complement of the seeding case, and the reason the predicate reconciles against the blob
    // rather than only flipping 0 → 1: a row FLAGGED with no vector (a console `SET embedding_blob =
    // NULL`, a restored backup) makes the funnel OVER-report, and no write site is left to fix it.
    await db.execute(
      "update tracks set has_embedding = 1 where track_id = 'bare00000000000000000a'",
    );

    const { flipped } = await backfillHasEmbedding(db);

    expect(flipped).toBe(2); // the un-flagged embedded row AND the flagged bare one
    expect(await mirror("emb000000000000000000a")).toBe(1);
    expect(await mirror("bare00000000000000000a")).toBe(0);
  });
});
