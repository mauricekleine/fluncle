import { type Client } from "@libsql/client";

import { beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack } from "../src/lib/server/integration-db";
import { backfillTrackEmbeddings } from "./backfill-track-embeddings";

// THE VECTOR SATELLITE BACKFILL — the data move behind the `track_embeddings` split
// (schema.ts § `trackEmbeddings`). Every vector still in the legacy `tracks.embedding_blob` column
// must end up in the satellite, and the run must be able to SAY so: the Worker ships after this
// step in `deploy:cf` and reads the satellite as the sole source of truth, so a vector left behind
// is a track that silently stops being recommendable, mixable and searchable-by-sound.
//
// Driven against the real migrated schema so the SQL under test is byte-identical to production's —
// including `vector32()`, which only a real libSQL has.

let db: Client;

/** Seed a catalogue row carrying a LEGACY vector — the pre-split state history is in. */
async function seedLegacy(trackId: string, first: number): Promise<void> {
  await seedCatalogueTrack(db, { title: `Track ${trackId}`, trackId });
  await db.execute({
    args: [JSON.stringify([first, ...Array.from({ length: 1023 }, () => 0.01)]), trackId],
    sql: "update tracks set embedding_blob = vector32(?) where track_id = ?",
  });
}

async function satelliteCount(): Promise<number> {
  const result = await db.execute("select count(*) as n from track_embeddings");

  return Number(result.rows[0]?.n ?? 0);
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("backfillTrackEmbeddings", () => {
  it("copies every legacy vector and asserts the destination count matches the source", async () => {
    await seedLegacy("leg000000000000000001a", 1);
    await seedLegacy("leg000000000000000002a", 0.5);
    await seedCatalogueTrack(db, { title: "Bare", trackId: "bar000000000000000001a" });

    const result = await backfillTrackEmbeddings(db, { chunkSize: 1 });

    // THE COUNT ASSERTION, both directions: nothing left behind, and the destination holds
    // exactly the source's rows on a first run (a bare row contributes to neither).
    expect(result.remaining).toBe(0);
    expect(result.source).toBe(2);
    expect(result.destination).toBe(2);
    expect(result.copied).toBe(2);
    expect(await satelliteCount()).toBe(2);
  });

  it("moves the BYTES, not just the keys — the copied vector round-trips", async () => {
    const { readEmbeddingBlob } = await import("../src/lib/server/embedding");

    await seedLegacy("leg000000000000000001a", 0.75);
    await backfillTrackEmbeddings(db);

    const copied = await db.execute(
      "select embedding_blob from track_embeddings where track_id = 'leg000000000000000001a'",
    );

    expect(readEmbeddingBlob(copied.rows[0]?.embedding_blob)?.[0]).toBeCloseTo(0.75, 5);
  });

  it("walks past the chunk boundary rather than stopping at it", async () => {
    // The cursor is the previous page's last id, so a corpus several chunks deep must drain
    // completely. A run that silently stopped at the first page would still report `remaining > 0`,
    // which is the belt; this is the braces.
    for (let index = 0; index < 7; index += 1) {
      await seedLegacy(`leg00000000000000000${index}a`, 0.1 * (index + 1));
    }

    const result = await backfillTrackEmbeddings(db, { chunkSize: 2 });

    expect(result.copied).toBe(7);
    expect(result.remaining).toBe(0);
    expect(await satelliteCount()).toBe(7);
  });

  it("is idempotent — a second run copies nothing and changes no state", async () => {
    await seedLegacy("leg000000000000000001a", 1);
    await backfillTrackEmbeddings(db);

    const second = await backfillTrackEmbeddings(db);

    expect(second.copied).toBe(0);
    expect(second.remaining).toBe(0);
    expect(await satelliteCount()).toBe(1);
  });

  it("never overwrites a LIVE satellite vector with the stale legacy copy underneath it", async () => {
    const { readEmbeddingBlob } = await import("../src/lib/server/embedding");
    const { seedEmbedding } = await import("../src/lib/server/integration-db");

    // The row was re-embedded after the split: the satellite holds the new vector while the legacy
    // column still holds the old one. `insert or ignore` is what keeps the re-run from rewinding it.
    await seedLegacy("leg000000000000000001a", 1);
    await seedEmbedding(db, "leg000000000000000001a", [
      0.25,
      ...Array.from({ length: 1023 }, () => 0.01),
    ]);

    const result = await backfillTrackEmbeddings(db);

    expect(result.copied).toBe(0);
    expect(result.remaining).toBe(0);

    const kept = await db.execute(
      "select embedding_blob from track_embeddings where track_id = 'leg000000000000000001a'",
    );

    expect(readEmbeddingBlob(kept.rows[0]?.embedding_blob)?.[0]).toBeCloseTo(0.25, 5);
  });

  it("reports a destination LARGER than the source once the app has minted its own vectors", async () => {
    const { seedEmbedding } = await import("../src/lib/server/integration-db");

    await seedLegacy("leg000000000000000001a", 1);
    await seedCatalogueTrack(db, { title: "Born after", trackId: "new000000000000000001a" });
    await seedEmbedding(db, "new000000000000000001a", [
      0.4,
      ...Array.from({ length: 1023 }, () => 0.01),
    ]);

    const result = await backfillTrackEmbeddings(db);

    // Equality holds only on the FIRST run, which is why the pass verifies `remaining === 0`
    // instead: a vector born in the satellite has no legacy row to be counted against.
    expect(result.source).toBe(1);
    expect(result.destination).toBe(2);
    expect(result.remaining).toBe(0);
  });
});
