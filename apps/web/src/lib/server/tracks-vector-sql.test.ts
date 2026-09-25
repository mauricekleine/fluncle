import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cosineSimilarity, EMBEDDING_DIMS, readEmbeddingBlob, toVectorProbe } from "./embedding";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import { resetKeyHistogramCache } from "./key-histogram";
import { VectorDeadlineExpired } from "./vector-fallback";

function sqlOf(statement: unknown): string {
  if (typeof statement === "string") {
    return statement;
  }

  const sql = (statement as { sql?: unknown } | undefined)?.sql;

  return typeof sql === "string" ? sql : "";
}

function metadataOf(statement: Record<string | symbol, unknown> | undefined): unknown {
  const symbol = statement ? Object.getOwnPropertySymbols(statement)[0] : undefined;

  return symbol ? statement?.[symbol] : undefined;
}
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

const execute = vi.hoisted(() => vi.fn());
let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => ({ execute }) };
});

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
    await seedTrack(db, { logId: `${100 + index}.${index % 10}.1A`, trackId: row.trackId });
    await db.execute({
      args: [
        row.key,
        row.bpm,

        JSON.stringify({ centroidHz: 1000 + index, highRatio: index / 100, onsetRate: index }),
        row.trackId,
      ],
      sql: `update tracks
            set key = ?1, bpm = ?2, features_json = ?3
            where track_id = ?4`,
    });

    await seedEmbedding(db, row.trackId, row.embedding ?? null);
    await db.execute({
      args: [row.galaxyId ?? null, row.trackId],
      sql: `update findings set galaxy_id = ? where track_id = ?`,
    });
  }
}

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

    expect(sonicGateOpen(30)).toBe(true);

    for (const limit of [1, 5, 12]) {
      const fromSql = (await getMixableTracks("t_00", { limit })).map(
        (candidate) => candidate.trackId,
      );

      expect(fromSql).toEqual(rankInIsolate(rows, "t_00", limit));
      expect(fromSql).toHaveLength(limit);
    }
  });

  it("bounds the candidate scan whether or not the target carries a vector", async () => {
    await seed(corpus());

    for (const targetHasVector of [true, false]) {
      await seedEmbedding(db, "t_00", targetHasVector ? pseudoVector(1) : null);
      execute.mockClear();

      await getMixableTracks("t_00", { limit: 12 });

      const scan = execute.mock.calls
        .map(([statement]) => statement as Record<string | symbol, unknown>)
        .find((statement) => sqlOf(statement).includes("as sonic_dist"));

      expect(scan, `candidate scan issued (target vector: ${targetHasVector})`).toBeDefined();
      expect(metadataOf(scan)).toEqual({
        accessClass: "heavy-read",
        operationId: "sonar.fallback.mix",
      });
    }
  });

  it("serves an empty rail when the scan blows its deadline, and never a fault", async () => {
    await seed(corpus());

    const realExecute = execute.getMockImplementation();
    execute.mockImplementation((query: unknown) => {
      return sqlOf(query).includes("as sonic_dist")
        ? Promise.reject(new VectorDeadlineExpired("sonar.fallback.mix", 6_000))
        : realExecute?.(query);
    });

    await expect(getMixableTracks("t_00", { limit: 12 })).resolves.toEqual([]);
  });

  it("still faults on a real database error, so a broken query cannot hide as an empty rail", async () => {
    await seed(corpus());

    const realExecute = execute.getMockImplementation();
    execute.mockImplementation((query: unknown) => {
      return sqlOf(query).includes("as sonic_dist")
        ? Promise.reject(new Error("no such column: tracks.nope"))
        : realExecute?.(query);
    });

    await expect(getMixableTracks("t_00", { limit: 12 })).rejects.toThrow("no such column");
  });

  it("answers identically whether or not the candidate scan joins findings", async () => {
    const rows = corpus();

    await seed(rows);

    const withoutJoin = await getMixableTracks("t_00", { limit: 12 });

    const withJoin = await getMixableTracks("t_00", { exclude: ["999.9.9Z"], limit: 12 });

    expect(withJoin).toEqual(withoutJoin);
    expect(withoutJoin.every((candidate) => candidate.certified)).toBe(true);
    expect(withoutJoin.every((candidate) => typeof candidate.logId === "string")).toBe(true);
  });

  it("keeps an uncertified candidate on the rail on both sides of that branch", async () => {
    await seed(corpus());
    await seedCatalogueTrack(db, { trackId: "t_unlit" });
    await db.execute({
      args: ["A minor", 172, JSON.stringify({ centroidHz: 1200, highRatio: 0.2, onsetRate: 9 })],
      sql: `update tracks set key = ?1, bpm = ?2, features_json = ?3 where track_id = 't_unlit'`,
    });
    await seedEmbedding(db, "t_unlit", pseudoVector(99));

    const withoutJoin = await getMixableTracks("t_00", { limit: 30 });
    const withJoin = await getMixableTracks("t_00", { exclude: ["999.9.9Z"], limit: 30 });

    expect(withoutJoin.map((candidate) => candidate.trackId)).toContain("t_unlit");
    expect(withJoin).toEqual(withoutJoin);
    expect(withoutJoin.find((candidate) => candidate.trackId === "t_unlit")).toMatchObject({
      certified: false,
      logId: undefined,
    });
  });

  it("starts the archive's key-spelling read without waiting for the target row", async () => {
    await seed(corpus());
    resetKeyHistogramCache();

    const started: string[] = [];
    let resolveTarget: (() => void) | undefined;
    const targetGate = new Promise<void>((resolve) => {
      resolveTarget = resolve;
    });

    execute.mockImplementation(async (query: unknown) => {
      const sql = String((query as { sql?: string }).sql ?? query);
      started.push(sql);

      if (sql.includes("resolved_track")) {
        await targetGate;
      }

      return db.execute(query as never);
    });

    const rail = getMixableTracks("t_00", { limit: 12 });

    await vi.waitFor(() => expect(started.some((sql) => sql.includes("group by key"))).toBe(true));
    resolveTarget?.();

    expect(await rail).not.toHaveLength(0);
  });

  it("keeps the reason chip the engine picked", async () => {
    await seed(corpus());

    const [first] = await getMixableTracks("t_00", { limit: 1 });

    expect(first?.reason).toMatchObject({ kind: expect.any(String) });
  });

  it("scores a candidate with no vector as vector-less", async () => {
    const rows = corpus();

    await seed(rows);
    await seedEmbedding(db, "t_01", null);
    await seedEmbedding(db, "t_02", null);

    const fromSql = (await getMixableTracks("t_00", { limit: 12 })).map(
      (candidate) => candidate.trackId,
    );

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

describe("getGalaxyAuditionMembers", () => {
  it("hydrates the same core-first order with the audition fields, minus the graph fields", async () => {
    const rows = corpus();

    await seed(rows);

    const centroid = pseudoVector(1);
    const fat = await getFindingsByGalaxyRanked("galaxy-0", centroid, 8, 0);
    const lean = await getGalaxyAuditionMembers("galaxy-0", centroid, 8, 0);

    expect(lean.map((item) => item.trackId)).toEqual(fat.map((item) => item.trackId));

    const first = lean[0];
    expect(first).toBeDefined();

    expect(first?.title).toBe("Test Track");
    expect(first?.artists).toEqual(["Test Artist"]);
    expect(first?.logId).toBeDefined();

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

    const row = await db.execute(
      `select embedding_blob from track_embeddings where track_id = 't_00'`,
    );

    expect(Object.prototype.toString.call(row.rows[0]?.embedding_blob)).toBe(
      "[object ArrayBuffer]",
    );

    const decoded = readEmbeddingBlob(row.rows[0]?.embedding_blob);
    const original = pseudoVector(1);

    expect(decoded).not.toBeNull();

    expect(cosineSimilarity(decoded ?? [], original)).toBeCloseTo(1, 6);
  });
});

function atCosine(cos: number, spread: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);

  values[0] = cos;
  values[spread] = Math.sqrt(Math.max(0, 1 - cos * cos));

  return values;
}

function axis(index: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);

  values[index] = 1;

  return values;
}

function logIdFor(index: number): string {
  return `${100 + index}.${index % 10}.1A`;
}

function gateFillers(key: string): MixSeed[] {
  return Array.from({ length: 10 }, (_, index) => ({
    bpm: 172,
    embedding: axis(200 + index),
    key,
    trackId: `t_fill_${index}`,
  }));
}

describe("the /mix rail ranks by adjacency to the chain's LAST track", () => {
  it("re-ranks by mixability × adjacency, flipping a pair plain mixability ordered the other way", async () => {
    const rows: MixSeed[] = [
      { bpm: 172, embedding: axis(0), key: "A minor", trackId: "t_target" },

      { bpm: 172, embedding: atCosine(0.635, 1), key: "A minor", trackId: "t_same_far" },

      { bpm: 172, embedding: atCosine(0.77, 2), key: "B minor", trackId: "t_energy_near" },
      ...gateFillers("A minor"),
    ];

    await seed(rows);

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

    const plain = rankInIsolatePlainMixability(rows, "t_target", 12);
    expect(plain.indexOf("t_same_far")).toBeLessThan(plain.indexOf("t_energy_near"));
  });

  it("takes the LAST track as the probe, never the chain's centroid", async () => {
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
      ...gateFillers("A minor"),
    ];

    await seed(rows);

    const rail = (
      await getMixableTracks("t_tail", {
        exclude: [logIdFor(0), logIdFor(1)],
        limit: 12,
      })
    ).map((candidate) => candidate.trackId);

    expect(rail.indexOf("t_near_tail")).toBeLessThan(rail.indexOf("t_centroid"));

    expect(rail).not.toContain("t_head");
    expect(rail).not.toContain("t_tail");
  });

  it("falls back to plain mixability when the last track has no vector to probe with", async () => {
    const rows: MixSeed[] = [
      { bpm: 172, embedding: null, key: "A minor", trackId: "t_target" },
      { bpm: 172, embedding: atCosine(0.9, 1), key: "A minor", trackId: "t_near" },
      { bpm: 172, embedding: atCosine(0.55, 2), key: "A minor", trackId: "t_far" },
      ...gateFillers("A minor"),
    ];

    await seed(rows);

    const rail = (await getMixableTracks("t_target", { limit: 12 })).map(
      (candidate) => candidate.trackId,
    );

    expect(rail).toEqual(rankInIsolatePlainMixability(rows, "t_target", 12));
  });
});

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
