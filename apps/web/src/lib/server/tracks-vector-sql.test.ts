import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillEmbeddingBlob } from "../../../scripts/backfill-embedding-blob";
import { cosineSimilarity, EMBEDDING_DIMS, readEmbeddingBlob } from "./embedding";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { rankMixable, sonicGateOpen, toMixTrack } from "./mixability";
import { getFindingsByGalaxyRanked, getMixableTracks } from "./tracks";

// The other two readers that used to pull every vector into the isolate, now ranked IN SQL
// (lib/server/embedding.ts, docs/rfcs/turso-scale-spike.md): the `/mix` rail
// (`getMixableTracks` — the DB computes each candidate's cosine to the target) and a
// galaxy's core-first order (`getFindingsByGalaxyRanked` — a `galaxy_id`-pre-filtered
// exact scan, paged in SQL). Real libSQL, real migrations, real vector functions — a mock
// could not exercise any of it.
//
// Each has a PIN: the same findings in the same order as the old in-isolate ranking.

const execute = vi.hoisted(() => vi.fn());
let db: Client;

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

/** A deterministic pseudo-random L2-normalized vector — a realistic dense MuQ shape. */
function pseudoVector(seed: number): number[] {
  let state = seed * 2654435761;
  const values: number[] = [];

  for (let index = 0; index < EMBEDDING_DIMS; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    values.push(state / 0x3fffffff - 1);
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));

  return values.map((value) => value / norm);
}

const KEYS = ["A minor", "C major", "E minor", "G major", "D minor", "F major"];

type MixSeed = {
  bpm: number | null;
  embedding: number[] | null;
  galaxyId?: string | null;
  key: string | null;
  trackId: string;
};

/** The pin's corpus: 30 findings with real keys, in-band BPMs, features and vectors. */
function corpus(): MixSeed[] {
  return Array.from({ length: 30 }, (_, index) => ({
    bpm: 170 + (index % 8),
    embedding: pseudoVector(index + 1),
    galaxyId: `galaxy-${index % 3}`,
    key: index % 7 === 6 ? null : (KEYS[index % KEYS.length] ?? null),
    trackId: `t_${String(index).padStart(2, "0")}`,
  }));
}

async function seed(rows: MixSeed[]): Promise<void> {
  for (const [index, row] of rows.entries()) {
    await seedTrack(db, { logId: `00${index % 9}.${index}.1A`, trackId: row.trackId });
    await db.execute({
      args: [
        row.key,
        row.bpm,
        row.embedding ? JSON.stringify(row.embedding) : null,
        // A distinct, deterministic texture vector per finding (the plateau tiebreak).
        JSON.stringify({ centroidHz: 1000 + index, highRatio: index / 100, onsetRate: index }),
        row.galaxyId ?? null,
        row.trackId,
      ],
      sql: `update tracks
            set key = ?, bpm = ?, embedding_json = ?, features_json = ?, galaxy_id = ?
            where track_id = ?`,
    });
  }
}

/** The reference ranking for `/mix`: the OLD path, scoring from vectors held in memory. */
function rankInIsolate(rows: MixSeed[], targetId: string, limit: number): string[] {
  const target = rows.find((row) => row.trackId === targetId);

  if (!target) {
    return [];
  }

  const toRow = (row: MixSeed) => ({
    bpm: row.bpm,
    embedding_json: row.embedding ? JSON.stringify(row.embedding) : null,
    features_json: JSON.stringify({
      centroidHz: 1000 + rows.indexOf(row),
      highRatio: rows.indexOf(row) / 100,
      onsetRate: rows.indexOf(row),
    }),
    key: row.key,
  });
  const candidates = rows
    .filter((row) => row.trackId !== targetId)
    .map((row) => ({ item: row.trackId, track: toMixTrack(toRow(row)) }));
  const embedded = rows.filter((row) => row.embedding !== null).length;

  return rankMixable(toMixTrack(toRow(target)), candidates, limit, {
    gateOpen: sonicGateOpen(embedded),
  }).map((entry) => entry.item);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  execute.mockReset();
  execute.mockImplementation((query: unknown) => db.execute(query as never));
});

describe("getMixableTracks", () => {
  it("returns exactly what the old in-isolate scoring returned (same findings, same order)", async () => {
    const rows = corpus();

    await seed(rows);
    await backfillEmbeddingBlob(db);

    // The sonic gate is OPEN at 30 embedded findings (435 pairs ≥ 50), so the MuQ term is
    // live and this really is pinning the SQL-computed cosine against the JS-computed one.
    expect(sonicGateOpen(30)).toBe(true);

    for (const limit of [1, 5, 12]) {
      const fromSql = (await getMixableTracks("t_00", { limit })).map(
        (candidate) => candidate.trackId,
      );

      expect(fromSql).toEqual(rankInIsolate(rows, "t_00", limit));
      expect(fromSql).toHaveLength(limit);
    }
  });

  it("keeps the reason chip the engine picked", async () => {
    await seed(corpus());
    await backfillEmbeddingBlob(db);

    const [first] = await getMixableTracks("t_00", { limit: 1 });

    expect(first?.reason).toMatchObject({ kind: expect.any(String) });
  });

  it("scores a candidate the backfill has not reached yet, from its JSON", async () => {
    const rows = corpus();

    await seed(rows);
    await backfillEmbeddingBlob(db);
    await db.execute(`update tracks set embedding_blob = null where track_id in ('t_01','t_02')`);

    const fromSql = (await getMixableTracks("t_00", { limit: 12 })).map(
      (candidate) => candidate.trackId,
    );

    expect(fromSql).toEqual(rankInIsolate(rows, "t_00", 12));
  });

  it("drops the excluded Log IDs server-side", async () => {
    await seed(corpus());
    await backfillEmbeddingBlob(db);

    const [first] = await getMixableTracks("t_00", { limit: 1 });
    const excluded = await getMixableTracks("t_00", {
      excludeLogIds: [first?.logId ?? ""],
      limit: 1,
    });

    expect(excluded[0]?.logId).not.toBe(first?.logId);
  });

  it("still ranks on key + BPM when the target has no vector (the sonic term goes null)", async () => {
    const rows = corpus().map((row) =>
      row.trackId === "t_00" ? { ...row, embedding: null } : row,
    );

    await seed(rows);
    await backfillEmbeddingBlob(db);

    const fromSql = (await getMixableTracks("t_00", { limit: 6 })).map(
      (candidate) => candidate.trackId,
    );

    expect(fromSql).toEqual(rankInIsolate(rows, "t_00", 6));
    expect(fromSql).not.toHaveLength(0);
  });

  it("returns [] for an unknown coordinate", async () => {
    await seed(corpus());

    expect(await getMixableTracks("nope")).toEqual([]);
  });
});

describe("getFindingsByGalaxyRanked", () => {
  it("orders a galaxy's members core-first, and pages in SQL", async () => {
    const rows = corpus();

    await seed(rows);
    await backfillEmbeddingBlob(db);

    const centroid = pseudoVector(1);
    const members = rows.filter((row) => row.galaxyId === "galaxy-0");
    const expected = [...members]
      .sort(
        (left, right) =>
          cosineSimilarity(centroid, right.embedding ?? []) -
          cosineSimilarity(centroid, left.embedding ?? []),
      )
      .map((row) => row.trackId);

    const page1 = await getFindingsByGalaxyRanked("galaxy-0", centroid, 4, 0);
    const page2 = await getFindingsByGalaxyRanked("galaxy-0", centroid, 4, 4);

    expect(page1.map((item) => item.trackId)).toEqual(expected.slice(0, 4));
    expect(page2.map((item) => item.trackId)).toEqual(expected.slice(4, 8));
  });

  it("sorts a member with no vector last rather than crashing the order", async () => {
    const rows = corpus().map((row) =>
      row.trackId === "t_00" ? { ...row, embedding: null } : row,
    );

    await seed(rows);
    await backfillEmbeddingBlob(db);

    const ranked = await getFindingsByGalaxyRanked("galaxy-0", pseudoVector(1), 20, 0);
    const ids = ranked.map((item) => item.trackId);

    expect(ids).toContain("t_00");
    expect(ids[ids.length - 1]).toBe("t_00");
  });

  it("returns [] for a galaxy with no members", async () => {
    await seed(corpus());

    expect(await getFindingsByGalaxyRanked("galaxy-none", pseudoVector(1), 10, 0)).toEqual([]);
  });
});

describe("backfillEmbeddingBlob", () => {
  it("converts every readable vector, and is a no-op on a second run", async () => {
    await seed(corpus());

    const first = await backfillEmbeddingBlob(db);

    expect(first).toEqual({ converted: 30, malformed: 0 });

    const second = await backfillEmbeddingBlob(db);

    expect(second).toEqual({ converted: 0, malformed: 0 });
  });

  it("writes the same float32s the JSON held (the blob round-trips)", async () => {
    await seed(corpus());
    await backfillEmbeddingBlob(db);

    const row = await db.execute(`select embedding_blob from tracks where track_id = 't_00'`);
    // The driver hands a blob back as an ArrayBuffer, NOT a Uint8Array — the quirk
    // `readEmbeddingBlob` exists to absorb.
    expect(Object.prototype.toString.call(row.rows[0]?.embedding_blob)).toBe(
      "[object ArrayBuffer]",
    );

    const decoded = readEmbeddingBlob(row.rows[0]?.embedding_blob);
    const original = pseudoVector(1);

    expect(decoded).not.toBeNull();
    // float32 storage, so compare at float32 precision, not bit-for-bit against a float64.
    expect(cosineSimilarity(decoded ?? [], original)).toBeCloseTo(1, 6);
  });

  it("skips an unreadable vector and NAMES it rather than throwing", async () => {
    await seed(corpus());
    await db.execute(
      `update tracks set embedding_json = '["x"]' where track_id in ('t_01','t_02')`,
    );

    const result = await backfillEmbeddingBlob(db);

    expect(result).toEqual({ converted: 28, malformed: 2 });
  });
});
