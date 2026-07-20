import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cosineSimilarity, EMBEDDING_DIMS, readEmbeddingBlob, toVectorProbe } from "./embedding";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { parseKey, toCamelot } from "../key-camelot";
import { isNamedMove, rankMixable, sonicGateOpen, toMixTrack } from "./mixability";
import { getFindingsByGalaxyRanked, getMixableTracks, getTasteCosines } from "./tracks";

// The other two readers that used to pull every vector into the isolate, now ranked IN SQL
// (lib/server/embedding.ts, docs/local-database.md "Local is not production"): the `/mix` rail
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
    // A VALID finding coordinate per `isLogId` (`\d{3,4}\.\d\.\d[A-Z]`): a unique 3-digit
    // sector, a single-digit middle, a digit+letter tail. The rail now routes an exclusion
    // token by `isLogId` (a chain holds catalogue tracks too, keyed by Spotify id), so a
    // malformed fixture coordinate would misroute as a track id and silently not exclude.
    await seedTrack(db, { logId: `${100 + index}.${index % 10}.1A`, trackId: row.trackId });
    await db.execute({
      args: [
        row.key,
        row.bpm,
        row.embedding ? JSON.stringify(row.embedding) : null,
        // A distinct, deterministic texture vector per finding (the plateau tiebreak).
        JSON.stringify({ centroidHz: 1000 + index, highRatio: index / 100, onsetRate: index }),
        row.trackId,
      ],
      // `vector32(NULL)` throws, so an un-embedded fixture writes a null blob explicitly.
      sql: `update tracks
            set key = ?1, bpm = ?2,
                embedding_blob = case when ?3 is null then null else vector32(?3) end,
                features_json = ?4
            where track_id = ?5`,
    });
    await db.execute({
      args: [row.galaxyId ?? null, row.trackId],
      sql: `update findings set galaxy_id = ? where track_id = ?`,
    });
  }
}

/**
 * The reference ranking for `/mix`: score from vectors held in memory, over the SAME
 * candidate pool the SQL path scans. That pool is now the NAMED-MOVE neighbourhood, not the
 * whole archive — `getMixableTracks` pre-filters `key in (…)` to the ~8 Camelot classes a
 * named harmonic move can reach (a distant-key pair is not a move a DJ makes, and the depth
 * gate guarantees the neighbourhood is deep enough to fill the rail). So the reference
 * applies the same filter before ranking; the pin is still "the SQL cosine equals the JS
 * cosine, in the same order", which is what this test exists to prove.
 */
function rankInIsolate(rows: MixSeed[], targetId: string, limit: number): string[] {
  const target = rows.find((row) => row.trackId === targetId);
  const targetKey = target ? parseKey(target.key) : null;

  if (!target || !targetKey) {
    return [];
  }

  const targetCamelot = toCamelot(targetKey);
  const toRow = (row: MixSeed) => ({
    bpm: row.bpm,
    embedding_blob: row.embedding ? toVectorProbe(row.embedding) : null,
    features_json: JSON.stringify({
      centroidHz: 1000 + rows.indexOf(row),
      highRatio: rows.indexOf(row) / 100,
      onsetRate: rows.indexOf(row),
    }),
    key: row.key,
  });
  const candidates = rows
    .filter((row) => {
      if (row.trackId === targetId) {
        return false;
      }

      const parsed = parseKey(row.key);

      return parsed ? isNamedMove(targetCamelot, toCamelot(parsed)) : false;
    })
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

    const [first] = await getMixableTracks("t_00", { limit: 1 });

    expect(first?.reason).toMatchObject({ kind: expect.any(String) });
  });

  it("scores a candidate with no blob as vector-less", async () => {
    // The scan reads the native `embedding_blob` column and the DB does the cosine in SQL. A
    // candidate with no blob keeps its place on the rail (key+BPM still mix) but its sonic term
    // goes null, exactly as an un-embedded row. Safe: the write path always sets the blob
    // (track-update.ts), so this state does not occur outside a test.
    const rows = corpus();

    await seed(rows);
    await db.execute(`update tracks set embedding_blob = null where track_id in ('t_01','t_02')`);

    const fromSql = (await getMixableTracks("t_00", { limit: 12 })).map(
      (candidate) => candidate.trackId,
    );

    // The reference treats the two blob-less rows as vector-less, and the SQL ranking agrees.
    const asSeen = rows.map((row) =>
      row.trackId === "t_01" || row.trackId === "t_02" ? { ...row, embedding: null } : row,
    );
    expect(fromSql).toEqual(rankInIsolate(asSeen, "t_00", 12));
  });

  it("drops the excluded tracks server-side", async () => {
    await seed(corpus());

    const [first] = await getMixableTracks("t_00", { limit: 1 });
    const excluded = await getMixableTracks("t_00", {
      exclude: [first?.logId ?? ""],
      limit: 1,
    });

    expect(excluded[0]?.logId).not.toBe(first?.logId);
  });

  it("still ranks on key + BPM when the target has no vector (the sonic term goes null)", async () => {
    const rows = corpus().map((row) =>
      row.trackId === "t_00" ? { ...row, embedding: null } : row,
    );

    await seed(rows);

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

describe("the seeded vector round-trips through vector32/readEmbeddingBlob", () => {
  it("writes the same float32s the JSON held", async () => {
    await seed(corpus());

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
});

// ── The taste fold ────────────────────────────────────────────────────────────────────────
// `getTasteCosines` is the `/mix` rail's second vector statement: each shortlisted track's
// similarity to its NEAREST seed probe. It used to be one `union all` branch per probe over a
// `shortlist` CTE — the flattening trap (docs/local-database.md), which re-read every
// shortlisted vector once per probe. It is now ONE pass with the probes folded by scalar
// `min(…)` in the select list.
//
// The pin is the file's usual one: the SQL cosine equals the JS cosine. Both branches are
// covered on purpose — single-argument `min()` is SQLite's AGGREGATE min, so a one-probe query
// that wrapped its lone term would collapse the whole scan to a single row instead of scoring
// every track, and it would do so SILENTLY.

/** The reference: each track's max similarity over the probes, computed in the isolate. */
function tasteInIsolate(
  rows: MixSeed[],
  trackIds: string[],
  probes: number[][],
): Map<string, number> {
  const best = new Map<string, number>();

  for (const trackId of trackIds) {
    const embedding = rows.find((row) => row.trackId === trackId)?.embedding;

    if (!embedding) {
      continue;
    }

    best.set(trackId, Math.max(...probes.map((probe) => cosineSimilarity(embedding, probe))));
  }

  return best;
}

describe("the /mix taste fold ranks in SQL", () => {
  const shortlist = ["t_01", "t_02", "t_03", "t_04", "t_05"];

  it("matches the in-isolate max-similarity over many probes", async () => {
    const rows = corpus();

    await seed(rows);

    const probes = [pseudoVector(11), pseudoVector(12), pseudoVector(13)];
    const cosines = await getTasteCosines(
      shortlist,
      probes.map((probe) => toVectorProbe(probe)),
    );
    const expected = tasteInIsolate(rows, shortlist, probes);

    expect([...cosines.keys()].sort()).toEqual(shortlist);

    for (const trackId of shortlist) {
      // float32 storage, so compare at float32 precision.
      expect(cosines.get(trackId)).toBeCloseTo(expected.get(trackId) ?? Number.NaN, 6);
    }
  });

  it("scores EVERY track on a single probe rather than collapsing to one row", async () => {
    const rows = corpus();

    await seed(rows);

    const probe = pseudoVector(11);
    const cosines = await getTasteCosines(shortlist, [toVectorProbe(probe)]);
    const expected = tasteInIsolate(rows, shortlist, [probe]);

    expect([...cosines.keys()].sort()).toEqual(shortlist);

    for (const trackId of shortlist) {
      expect(cosines.get(trackId)).toBeCloseTo(expected.get(trackId) ?? Number.NaN, 6);
    }
  });

  it("skips a shortlisted track with no vector instead of failing the scan", async () => {
    const rows = corpus().map((row) =>
      row.trackId === "t_03" ? { ...row, embedding: null } : row,
    );

    await seed(rows);

    const cosines = await getTasteCosines(shortlist, [toVectorProbe(pseudoVector(11))]);

    expect(cosines.has("t_03")).toBe(false);
    expect([...cosines.keys()].sort()).toEqual(shortlist.filter((id) => id !== "t_03"));
  });
});
