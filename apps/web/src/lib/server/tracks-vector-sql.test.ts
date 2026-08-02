import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cosineSimilarity, EMBEDDING_DIMS, readEmbeddingBlob, toVectorProbe } from "./embedding";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { parseKey, toCamelot } from "../key-camelot";
import {
  applyTaste,
  isNamedMove,
  rankMixable,
  shortlistMixable,
  sonicGateOpen,
  TASTE_SHORTLIST,
  tasteSubScore,
  toMixTrack,
} from "./mixability";
import { getFindingsByGalaxyRanked, getGalaxyAuditionMembers, getMixableTracks } from "./tracks";

// The other two readers rank every vector IN SQL rather than pulling vectors into the isolate
// (lib/server/embedding.ts, docs/local-database.md "Local is not production"): the `/mix` rail
// (`getMixableTracks` — the DB computes each candidate's cosine to the target) and a
// galaxy's core-first order (`getFindingsByGalaxyRanked` — a `galaxy_id`-pre-filtered
// exact scan, paged in SQL). Real libSQL, real migrations, real vector functions — a mock
// could not exercise any of it.
//
// Each has a PIN: the same findings in the same order as an equivalent in-isolate ranking, so
// the claim under test is always "the SQL cosine equals the JS cosine", never "the SQL is fast".

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
 *
 * SINGLE-PROBE-ON-LAST: the rail is re-ranked by mixability × the candidate's calibrated
 * cosine to the TARGET (the chain's last track), so the reference runs the same two stages —
 * `shortlistMixable` then `applyTaste` — over cosines computed here in the isolate. When the
 * target has no vector, or the archive has not cleared the sonic gate, taste is not live and
 * the reference is the plain mixability order (which `applyTaste` over an all-null taste
 * reproduces exactly, ties falling back to the shortlist's own order).
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
    .map((row) => ({
      item: row.trackId,
      sonicCos:
        target.embedding && row.embedding
          ? cosineSimilarity(target.embedding, row.embedding)
          : null,
      track: toMixTrack(toRow(row)),
    }));
  const embedded = rows.filter((row) => row.embedding !== null).length;
  const gateOpen = sonicGateOpen(embedded);
  const options = { gateOpen };
  const shortlist = shortlistMixable(
    toMixTrack(toRow(target)),
    candidates,
    TASTE_SHORTLIST,
    options,
  );
  const tasteLive = target.embedding !== null && gateOpen;
  const cosByTrackId = new Map(
    candidates.flatMap((candidate) =>
      typeof candidate.sonicCos === "number" ? [[candidate.item, candidate.sonicCos] as const] : [],
    ),
  );

  return applyTaste(
    shortlist,
    (trackId) => (tasteLive ? tasteSubScore(cosByTrackId.get(trackId) ?? null) : null),
    limit,
  ).map((entry) => entry.item);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  execute.mockReset();
  execute.mockImplementation((query: unknown) => db.execute(query as never));
});

describe("getMixableTracks", () => {
  it("returns exactly what the in-isolate reference ranks (same findings, same order)", async () => {
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

// The `/admin/galaxies` naming audition reads members through the LEAN board projection
// (`getGalaxyAuditionMembers`) — the same core-first ranking, hydrated without the fat read's
// graph/discovery subqueries + heavy JSON columns none of the audition cards render. It must
// still carry the audition-critical identity fields (title, artists, Log ID) in the same
// order, or a cover shows blank; and it must NOT carry the graph fields the board projection
// drops (a silent field is what the split guards against).
describe("getGalaxyAuditionMembers", () => {
  it("hydrates the same core-first order with the audition fields, minus the graph fields", async () => {
    const rows = corpus();

    await seed(rows);

    const centroid = pseudoVector(1);
    const fat = await getFindingsByGalaxyRanked("galaxy-0", centroid, 8, 0);
    const lean = await getGalaxyAuditionMembers("galaxy-0", centroid, 8, 0);

    // Same ranking, same page — the two share `rankGalaxyMemberIds`.
    expect(lean.map((item) => item.trackId)).toEqual(fat.map((item) => item.trackId));

    const first = lean[0];
    expect(first).toBeDefined();
    // The audition renders these; a dropped one is a blank cover, not a win.
    expect(first?.title).toBe("Test Track");
    expect(first?.artists).toEqual(["Test Artist"]);
    expect(first?.logId).toBeDefined();
    // The board projection drops the graph/discovery fields the audition never reads.
    expect(first).not.toHaveProperty("galaxy");
    expect(first).not.toHaveProperty("albumSlug");
    expect(first).not.toHaveProperty("labelSlug");
  });

  it("returns [] for a galaxy with no members", async () => {
    await seed(corpus());

    expect(await getGalaxyAuditionMembers("galaxy-none", pseudoVector(1), 10, 0)).toEqual([]);
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

// ── SINGLE-PROBE-ON-LAST: the ratified `/mix` taste model ─────────────────────────────────
//
// The rail's taste probe is ONE vector — the LAST track of the chain, which is the target
// `getMixableTracks` is called with — and the rail is re-ranked by mixability × the calibrated
// cosine to it. These fixtures hold key and BPM flat wherever adjacency is the thing under
// test, so nothing but the vector can move the order.

/** A unit vector whose cosine to `axis(0)` is exactly `cos`, the remainder on `spread`. */
function atCosine(cos: number, spread: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);

  values[0] = cos;
  values[spread] = Math.sqrt(Math.max(0, 1 - cos * cos));

  return values;
}

/** The unit basis vector on `index`. */
function axis(index: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);

  values[index] = 1;

  return values;
}

/** `seed()`'s deterministic coordinate for the row at `index` — the chain's exclusion token. */
function logIdFor(index: number): string {
  return `${100 + index}.${index % 10}.1A`;
}

/**
 * Enough same-key, far-away rows to open the sonic coverage gate (11 embedded tracks in play).
 * Their cosine to the target is 0, so they calibrate to 0 and settle at the foot of the rail.
 */
function gateFillers(from: number, key: string): MixSeed[] {
  return Array.from({ length: 10 }, (_, index) => ({
    bpm: 172,
    embedding: axis(200 + index),
    key,
    trackId: `t_fill_${index}`,
  }));
}

describe("the /mix rail ranks by adjacency to the chain's LAST track", () => {
  it("re-ranks by mixability × adjacency, flipping a pair plain mixability ordered the other way", async () => {
    // t_same_far is the cleaner MIX (same key), t_energy_near the nearer SOUND (a whole-tone
    // energy move). Plain mixability prefers the first; single-probe-on-last prefers the second,
    // because what follows a tune is a question about that tune's sound.
    const rows: MixSeed[] = [
      { bpm: 172, embedding: axis(0), key: "A minor", trackId: "t_target" },
      // calibrate(0.635) = 0.3 → mix 0.755, rail 0.227
      { bpm: 172, embedding: atCosine(0.635, 1), key: "A minor", trackId: "t_same_far" },
      // calibrate(0.77) = 0.6 → mix 0.66, rail 0.396
      { bpm: 172, embedding: atCosine(0.77, 2), key: "B minor", trackId: "t_energy_near" },
      ...gateFillers(3, "A minor"),
    ];

    await seed(rows);

    // The fixture's premise: B minor really is a NAMED move off A minor (an energy boost), so
    // both candidates survive the `key in (…)` pre-filter and the comparison is about sound.
    const targetKey = parseKey("A minor");
    const energyKey = parseKey("B minor");
    expect(targetKey).not.toBeNull();
    expect(energyKey).not.toBeNull();
    expect(
      targetKey && energyKey ? isNamedMove(toCamelot(targetKey), toCamelot(energyKey)) : false,
    ).toBe(true);

    const rail = (await getMixableTracks("t_target", { limit: 12 })).map(
      (candidate) => candidate.trackId,
    );

    expect(rail[0]).toBe("t_energy_near");
    expect(rail.indexOf("t_energy_near")).toBeLessThan(rail.indexOf("t_same_far"));

    // …and the model really did change: plain mixability over the same pool orders them the
    // other way round. This is the RANKING CHANGE that lands on merge, pinned.
    const plain = rankInIsolatePlainMixability(rows, "t_target", 12);
    expect(plain.indexOf("t_same_far")).toBeLessThan(plain.indexOf("t_energy_near"));
  });

  it("takes the LAST track as the probe, never the chain's centroid", async () => {
    // A two-track chain pointing at two orthogonal places. `t_centroid` sits EXACTLY on their
    // mean — the row a fold over the chain would crown — while `t_near_tail` sits close to the
    // tail alone. The tail wins: the probe is the last track, and it is never averaged.
    const rows: MixSeed[] = [
      { bpm: 172, embedding: axis(0), key: "A minor", trackId: "t_head" },
      { bpm: 172, embedding: axis(1), key: "A minor", trackId: "t_tail" },
      {
        bpm: 172,
        embedding: axis(0).map((value, index) => (value + (axis(1)[index] ?? 0)) / Math.SQRT2),
        key: "A minor",
        trackId: "t_centroid",
      },
      {
        bpm: 172,
        embedding: axis(1).map((value, index) => value * 0.95 + (axis(2)[index] ?? 0) * 0.3122),
        key: "A minor",
        trackId: "t_near_tail",
      },
      ...gateFillers(4, "A minor"),
    ];

    await seed(rows);

    const rail = (
      await getMixableTracks("t_tail", {
        // The chain, as the builder sends it: both already-picked tracks, by coordinate.
        exclude: [logIdFor(0), logIdFor(1)],
        limit: 12,
      })
    ).map((candidate) => candidate.trackId);

    expect(rail.indexOf("t_near_tail")).toBeLessThan(rail.indexOf("t_centroid"));
    // The chain stays off its own rail, whichever token kind named it.
    expect(rail).not.toContain("t_head");
    expect(rail).not.toContain("t_tail");
  });

  it("falls back to plain mixability when the last track has no vector to probe with", async () => {
    const rows: MixSeed[] = [
      { bpm: 172, embedding: null, key: "A minor", trackId: "t_target" },
      { bpm: 172, embedding: atCosine(0.9, 1), key: "A minor", trackId: "t_near" },
      { bpm: 172, embedding: atCosine(0.55, 2), key: "A minor", trackId: "t_far" },
      ...gateFillers(3, "A minor"),
    ];

    await seed(rows);

    const rail = (await getMixableTracks("t_target", { limit: 12 })).map(
      (candidate) => candidate.trackId,
    );

    // No probe ⇒ no adjacency to multiply by ⇒ today's un-seeded rail, unchanged.
    expect(rail).toEqual(rankInIsolatePlainMixability(rows, "t_target", 12));
  });
});

/** The OLD model's order: mixability alone, over the same named-move pool. */
function rankInIsolatePlainMixability(rows: MixSeed[], targetId: string, limit: number): string[] {
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
    .map((row) => ({
      item: row.trackId,
      sonicCos:
        target.embedding && row.embedding
          ? cosineSimilarity(target.embedding, row.embedding)
          : null,
      track: toMixTrack(toRow(row)),
    }));

  return rankMixable(toMixTrack(toRow(target)), candidates, limit, {
    gateOpen: sonicGateOpen(rows.filter((row) => row.embedding !== null).length),
  }).map((entry) => entry.item);
}
