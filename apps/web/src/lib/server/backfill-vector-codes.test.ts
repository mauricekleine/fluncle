// The int8 vector-code backfill (RFC vector-search-scale, slice A) against a real in-memory libSQL
// engine — the in-SQL `vector8(vector_extract(<blob>))` drain, its self-draining anti-set, and its
// idempotence. `getDb` is mocked to the per-test client (the artist-aliases precedent).
import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillVectorCodes } from "./backfill-vector-codes";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/** A dense 1024-d vector (the F32_BLOB(1024) width) from a simple seeded ramp — value irrelevant. */
function vector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_unused, index) => Math.sin(seed + index) * 0.5);
}

async function countF8Null(db: Client): Promise<number> {
  const result = await db.execute(
    `select count(*) as n from tracks where embedding_blob is not null and embedding_f8 is null`,
  );

  return Number(result.rows[0]?.n ?? 0);
}

describe("backfillVectorCodes", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await migrate(drizzle(db), { migrationsFolder });
    holder.db = db;

    // 5 embedded tracks with NO `embedding_f8` (the pre-column state) + 1 un-embedded row (must be
    // ignored — no `embedding_blob` to encode from) + 1 already-coded row (must not be re-touched).
    for (let i = 0; i < 5; i += 1) {
      await db.execute({
        args: [`t${i}`, JSON.stringify(vector(i))],
        sql: `insert into tracks (track_id, title, artists_json, duration_ms, embedding_blob)
              values (?, 'T', '["A"]', 270000, vector32(?))`,
      });
    }

    await db.execute(
      `insert into tracks (track_id, title, artists_json, duration_ms) values ('none', 'T', '["A"]', 270000)`,
    );
    await db.execute({
      args: [JSON.stringify(vector(99)), JSON.stringify(vector(99))],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, embedding_blob, embedding_f8)
            values ('coded', 'T', '["A"]', 270000, vector32(?), vector8(?))`,
    });

    // 2 artist centroids with NO `centroid_f8`.
    for (let i = 0; i < 2; i += 1) {
      await db.execute({
        args: [`a${i}`, JSON.stringify(vector(i + 10))],
        sql: `insert into artist_centroids (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
              values (?, vector32(?), '2026-01-01', 'v1:1', 1)`,
      });
    }
  });

  it("encodes the un-coded embedded rows in SQL, ignoring un-embedded and already-coded ones", async () => {
    expect(await countF8Null(db)).toBe(5);

    const summary = await backfillVectorCodes(500);

    expect(summary.tracksEncoded).toBe(5);
    expect(summary.centroidsEncoded).toBe(2);
    expect(summary.tracksRemaining).toBe(0);
    expect(summary.centroidsRemaining).toBe(0);
    // Every embedded row now carries a code; the un-embedded 'none' row still has neither.
    expect(await countF8Null(db)).toBe(0);
    const none = await db.execute(`select embedding_f8 from tracks where track_id = 'none'`);
    expect(none.rows[0]?.embedding_f8).toBeNull();
  });

  it("is bounded per tick and resumable, and a re-run on a settled archive is a no-op", async () => {
    const first = await backfillVectorCodes(2);

    expect(first.tracksEncoded).toBe(2);
    expect(first.tracksRemaining).toBe(3);

    const second = await backfillVectorCodes(2);
    expect(second.tracksEncoded).toBe(2);
    expect(second.tracksRemaining).toBe(1);

    const third = await backfillVectorCodes(2);
    expect(third.tracksEncoded).toBe(1);
    expect(third.tracksRemaining).toBe(0);

    // Settled: nothing left to do.
    const noop = await backfillVectorCodes(500);
    expect(noop.tracksEncoded).toBe(0);
    expect(noop.centroidsEncoded).toBe(0);
    expect(noop.tracksRemaining).toBe(0);
  });

  it("produces a code rankable by vector_distance_cos against a probe (the read contract)", async () => {
    await backfillVectorCodes(500);

    const probe = await db.execute({
      args: [JSON.stringify(vector(0))],
      sql: `select vector8(?) as p`,
    });
    const raw: unknown = probe.rows[0]?.p;
    const rawBytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw as Uint8Array);
    const ranked = await db.execute({
      args: [rawBytes],
      sql: `select track_id from tracks where embedding_f8 is not null
            order by vector_distance_cos(embedding_f8, ?) asc limit 1`,
    });

    // t0 was seeded from vector(0), so it is nearest to that probe.
    expect(ranked.rows[0]?.track_id).toBe("t0");
  });
});
