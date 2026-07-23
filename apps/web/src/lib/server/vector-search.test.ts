import { type Client as WebClient } from "@libsql/client/web";
import { beforeEach, describe, expect, it } from "vitest";
import { createIntegrationDb } from "./integration-db";
import { toVectorProbe } from "./embedding";
import {
  coarseColumnSql,
  coarseRescoreRank,
  encodeF8Probe,
  minCosDistanceSql,
} from "./vector-search";

// The two-pass coarse+rescore vector primitive (RFC vector-search-scale, slice A). The pure SQL
// builders are unit-tested directly; the two-pass rank is proven against REAL libSQL (the same
// `vector8` / `vector_distance_cos` production runs, via the integration harness that applies the
// generated migration adding `embedding_f8`) by comparing it to a brute-force EXACT float32 scan —
// the primitive must reproduce the exact scan's top-K, byte-for-byte, at ~4× smaller scan payload.

describe("the SQL builders", () => {
  it("folds one probe to a bare distance and many to an aggregate min (rule 4)", () => {
    expect(minCosDistanceSql("t.e8", 1)).toBe("vector_distance_cos(t.e8, ?)");
    expect(minCosDistanceSql("t.e8", 3)).toBe(
      "min(vector_distance_cos(t.e8, ?), vector_distance_cos(t.e8, ?), vector_distance_cos(t.e8, ?))",
    );
  });

  it("covers a mid-backfill NULL code with an on-the-fly re-encode of the float32 blob", () => {
    expect(coarseColumnSql("t.embedding_f8", "t.embedding_blob")).toBe(
      "coalesce(t.embedding_f8, vector8(vector_extract(t.embedding_blob)))",
    );
  });
});

// ── The two-pass rank against real libSQL ─────────────────────────────────────────────────────

/** A deterministic PRNG so the fixture vectors are fixed run-to-run. */
function mulberry32(seed: number): () => number {
  let state = seed;

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const DIMS = 1024;

/** A dense 1024-d vector from the PRNG (matches the F32_BLOB(1024) / F8_BLOB(1024) schema width). */
function randomVector(random: () => number): number[] {
  return Array.from({ length: DIMS }, () => random() * 2 - 1);
}

/** The brute-force EXACT float32 scan — the ground truth the two-pass rank must reproduce. */
async function exactTopK(
  db: WebClient,
  probe: number[],
  k: number,
  where = "embedding_blob is not null",
  whereArgs: (number | string)[] = [],
): Promise<string[]> {
  // The probe sits in the SELECT list (its `?` first, then the where args, then the limit) — the
  // SAME bind order the primitive uses, so a `where` carrying args binds correctly.
  const result = await db.execute({
    args: [toVectorProbe(probe), ...whereArgs, k],
    sql: `select track_id as id, vector_distance_cos(embedding_blob, ?) as d from tracks
          where ${where}
          order by d asc, track_id asc
          limit ?`,
  });

  return result.rows.map((row) => row.id as string);
}

describe("coarseRescoreRank against real libSQL", () => {
  let db: WebClient;
  const random = mulberry32(99);
  const vectors: number[][] = [];
  const count = 60;

  beforeEach(async () => {
    // The node integration client stands in for the /web client at runtime (existing tests mock
    // `getDb` with it); the direct call here casts across the structurally-identical `.execute`.
    db = (await createIntegrationDb()) as unknown as WebClient;
    vectors.length = 0;

    for (let i = 0; i < count; i += 1) {
      const trackId = `t${String(i).padStart(3, "0")}`;
      const vector = randomVector(random);
      vectors.push(vector);
      const bpm = 170 + (i % 3);
      // Most rows get BOTH vector columns; every 7th is left `embedding_f8` NULL — the mid-backfill
      // state the coarse scan's `coalesce` must transparently cover. The vector JSON binds once for
      // `vector32` and once for `vector8` (libSQL quantizes the same floats).
      const json = JSON.stringify(vector);
      const setF8 = i % 7 !== 0;
      await db.execute({
        args: setF8 ? [trackId, bpm, json, json] : [trackId, bpm, json],
        sql: `insert into tracks (track_id, title, artists_json, duration_ms, bpm, embedding_blob, embedding_f8)
              values (?, 'T', '["A"]', 270000, ?, vector32(?), ${setF8 ? "vector8(?)" : "null"})`,
      });
    }
  });

  it("reproduces the exact float32 top-K (100% recall + exact order)", async () => {
    const probe = vectors[5] ?? [];
    const coarseProbe = await encodeF8Probe(db, probe);

    expect(coarseProbe).not.toBeNull();

    const ranked = await coarseRescoreRank(db, {
      coarseFrom: "tracks",
      coarseProbes: coarseProbe ? [coarseProbe] : [],
      exactProbes: [toVectorProbe(probe)],
      f32Column: "embedding_blob",
      f8Column: "embedding_f8",
      idColumn: "track_id",
      k: 12,
      rescoreFrom: "tracks",
      where: "embedding_blob is not null",
      whereArgs: [],
    });

    expect(ranked.map((row) => row.id)).toEqual(await exactTopK(db, probe, 12));
    // The rescored distances are ascending (nearest first) and real cosine distances.
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i]?.distance ?? 0).toBeGreaterThanOrEqual(ranked[i - 1]?.distance ?? 0);
    }
  });

  it("still surfaces a mid-backfill (f8-NULL) row that is genuinely nearest (the coalesce cover)", async () => {
    // t000 has NO `embedding_f8` (i % 7 === 0). Probe with ITS OWN vector — it must rank #1 even
    // though its coarse code is only re-encoded on the fly.
    const probe = vectors[0] ?? [];
    const coarseProbe = await encodeF8Probe(db, probe);
    const ranked = await coarseRescoreRank(db, {
      coarseFrom: "tracks",
      coarseProbes: coarseProbe ? [coarseProbe] : [],
      exactProbes: [toVectorProbe(probe)],
      f32Column: "embedding_blob",
      f8Column: "embedding_f8",
      idColumn: "track_id",
      k: 5,
      rescoreFrom: "tracks",
      where: "embedding_blob is not null",
      whereArgs: [],
    });

    expect(ranked[0]?.id).toBe("t000");
  });

  it("composes a metadata pre-filter with the vector scan", async () => {
    const probe = vectors[5] ?? [];
    const coarseProbe = await encodeF8Probe(db, probe);
    const where = "embedding_blob is not null and bpm = ?";
    const whereArgs = [171];
    const ranked = await coarseRescoreRank(db, {
      coarseFrom: "tracks",
      coarseProbes: coarseProbe ? [coarseProbe] : [],
      exactProbes: [toVectorProbe(probe)],
      f32Column: "embedding_blob",
      f8Column: "embedding_f8",
      idColumn: "track_id",
      k: 8,
      rescoreFrom: "tracks",
      where,
      whereArgs,
    });

    // Every returned row cleared the bpm gate, and the set matches the exact scan under the SAME
    // filter — the pre-filter narrows candidates identically at both stages.
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.map((row) => row.id)).toEqual(await exactTopK(db, probe, 8, where, whereArgs));
  });

  it("folds multiple probes to the nearest-of (max-similarity, never a centroid)", async () => {
    const probeA = vectors[3] ?? [];
    const probeB = vectors[40] ?? [];
    const f8A = await encodeF8Probe(db, probeA);
    const f8B = await encodeF8Probe(db, probeB);
    const ranked = await coarseRescoreRank(db, {
      coarseFrom: "tracks",
      coarseProbes: [f8A, f8B].filter((probe): probe is Uint8Array => probe !== null),
      exactProbes: [toVectorProbe(probeA), toVectorProbe(probeB)],
      f32Column: "embedding_blob",
      f8Column: "embedding_f8",
      idColumn: "track_id",
      k: 6,
      rescoreFrom: "tracks",
      where: "embedding_blob is not null",
      whereArgs: [],
    });

    const ids = ranked.map((row) => row.id);
    // Each probe's OWN row is nearest to itself (distance ~0), so both seeds sit at the very top.
    expect(ids).toContain("t003");
    expect(ids).toContain("t040");
  });
});
