import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMS, readEmbeddingBlob } from "./embedding";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";
import { type PublicUser } from "./public-auth";
import { type SonarFilter, type SonarMatch } from "./sonar";

const isSonarArtistsEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarLogEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarRecsCatalogueEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarRecsEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarSonicEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./sonar", () => ({
  isSonarArtistsEnabled,
  isSonarLogEnabled,
  isSonarRecsCatalogueEnabled,
  isSonarRecsEnabled,
  isSonarSonicEnabled,
  searchSonar,
}));

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

function axis(index: number): number[] {
  const vector = Array.from<number>({ length: EMBEDDING_DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

type SonarRequest = {
  excludeIds?: string[];
  filter?: SonarFilter;
  index: string;
  probes: number[][];
  topK: number;
};

type IndexEntry = {
  anchored: boolean;
  certified: boolean;
  dismissed: boolean;
  durationMs: null | number;
  hasFinding: boolean;
  isDuplicate: boolean;
  nearestFindingScore: null | number;
  trackId: string;
  vector: number[];
};

async function loadIndex(): Promise<IndexEntry[]> {
  const result = await db.execute(
    `select t.track_id, e.embedding_blob, t.spotify_uri,
        f.track_id as finding_id, f.log_id as finding_log_id,
        t.dismissed_at, t.duplicate_of_track_id, t.nearest_finding_score, t.duration_ms
      from tracks t
      join track_embeddings e on e.track_id = t.track_id
      left join findings f on f.track_id = t.track_id`,
  );
  const entries: IndexEntry[] = [];

  for (const row of result.rows) {
    const vector = readEmbeddingBlob(row.embedding_blob);

    if (!vector) {
      continue;
    }

    entries.push({
      anchored: row.spotify_uri !== null,
      certified: row.finding_log_id !== null,
      dismissed: row.dismissed_at !== null,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      hasFinding: row.finding_id !== null,
      isDuplicate: row.duplicate_of_track_id !== null,
      nearestFindingScore:
        row.nearest_finding_score === null ? null : Number(row.nearest_finding_score),
      trackId: typeof row.track_id === "string" ? row.track_id : "",
      vector,
    });
  }

  return entries;
}

function passesFilter(entry: IndexEntry, filter: SonarFilter | undefined): boolean {
  if (!filter) {
    return true;
  }

  if (filter.anchored !== undefined && entry.anchored !== filter.anchored) {
    return false;
  }

  if (filter.certified !== undefined && entry.certified !== filter.certified) {
    return false;
  }

  if (filter.has_finding !== undefined && entry.hasFinding !== filter.has_finding) {
    return false;
  }

  if (filter.dismissed !== undefined && entry.dismissed !== filter.dismissed) {
    return false;
  }

  if (filter.is_duplicate !== undefined && entry.isDuplicate !== filter.is_duplicate) {
    return false;
  }

  if (filter.nearest_finding_score_max !== undefined) {
    const score = entry.nearestFindingScore;

    if (score !== null && !(score < filter.nearest_finding_score_max)) {
      return false;
    }
  }

  if (filter.duration_ms_max !== undefined) {
    const duration = entry.durationMs;

    if (duration === null || !(duration < filter.duration_ms_max)) {
      return false;
    }
  }

  return true;
}

function cosine(a: number[], b: number[]): number {
  const left = unit(a);
  const right = unit(b);
  let dot = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }

  return dot;
}

async function referenceSonar(request: SonarRequest): Promise<SonarMatch[]> {
  const excluded = new Set(request.excludeIds ?? []);
  const entries = await loadIndex();
  const matches: SonarMatch[] = [];

  for (const entry of entries) {
    if (excluded.has(entry.trackId) || !passesFilter(entry, request.filter)) {
      continue;
    }

    const score = Math.max(...request.probes.map((probe) => cosine(probe, entry.vector)));

    matches.push({ id: entry.trackId, score });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, request.topK);
}

function publicUser(id: string): PublicUser {
  return {
    createdAt: new Date().toISOString(),
    email: `${id}@example.com`,
    emailVerified: true,
    id,
    name: id,
    username: id,
  };
}

async function embed(trackId: string, vector: number[]): Promise<void> {
  await seedEmbedding(db, trackId, vector);
}

async function seedRow(trackId: string, weight: number, durationMs = 270_000): Promise<void> {
  await seedCatalogueTrack(db, {
    artists: [`Artist ${trackId}`],
    durationMs,
    title: `Track ${trackId}`,
    trackId,
  });
  await embed(trackId, blend(axis(0), axis(9), weight));
}

async function seedWorld(): Promise<PublicUser> {
  const { saveRecSeed } = await import("./recommendations");
  const user = publicUser("user-catalogue-sonar");

  await seedRow("cat-near", 0.1);
  await seedRow("cat-low-score", 0.12);
  await db.execute({
    args: ["cat-low-score"],
    sql: `update tracks set nearest_finding_score = 0.5 where track_id = ?`,
  });
  await seedRow("cat-null-score", 0.14);
  await seedRow("cat-mid", 0.2);
  await seedRow("cat-far", 0.3);

  await seedRow("ex-dismissed", 0.11);
  await db.execute({
    args: [new Date().toISOString(), "ex-dismissed"],
    sql: `update tracks set dismissed_at = ? where track_id = ?`,
  });

  await seedRow("ex-duplicate", 0.13);
  await db.execute({
    args: ["cat-near", "ex-duplicate"],
    sql: `update tracks set duplicate_of_track_id = ? where track_id = ?`,
  });

  await seedRow("ex-display-duplicate", 0.16);
  await db.execute({
    args: ["ex-display-duplicate"],
    sql: `update tracks set nearest_finding_score = 0.999 where track_id = ?`,
  });

  await seedRow("ex-long-form", 0.17, 30 * 60_000);
  await seedRow("ex-exactly-long-form", 0.18, 15 * 60_000);

  await seedRow("ex-unanchored", 0.19);
  await db.execute({
    args: ["ex-unanchored"],
    sql: `update tracks set spotify_uri = null, spotify_url = null where track_id = ?`,
  });

  await seedTrack(db, {
    artists: ["Artist ex-straggler"],
    logId: null,
    title: "Track ex-straggler",
    trackId: "ex-straggler",
  });
  await embed("ex-straggler", blend(axis(0), axis(9), 0.21));

  await seedTrack(db, {
    artists: ["Artist find-1"],
    logId: "001.1.1A",
    title: "Track find-1",
    trackId: "find-1",
  });
  await embed("find-1", blend(axis(0), axis(9), 0.25));

  await seedRow("seed-1", 0);
  await saveRecSeed(user, { trackId: "seed-1" });

  return user;
}

const EXPECTED_CATALOGUE = ["cat-near", "cat-low-score", "cat-null-score", "cat-mid", "cat-far"];

beforeEach(async () => {
  db = await createIntegrationDb();
  searchSonar.mockReset();
  isSonarRecsEnabled.mockReset();
  isSonarRecsEnabled.mockResolvedValue(false);
  isSonarRecsCatalogueEnabled.mockReset();
  isSonarRecsCatalogueEnabled.mockResolvedValue(false);
});

describe("listRecommendations — the CATALOGUE sonar route (dark, default OFF)", () => {
  it("FLAG OFF: never calls sonar, and the Turso fold answers exactly as today", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    const result = await listRecommendations(user);

    expect(searchSonar).not.toHaveBeenCalled();
    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.catalogue.map((row) => row.trackId)).toEqual(EXPECTED_CATALOGUE);
  });

  it("FLAG ON: sends ONE call carrying the WHOLE eligibility predicate, with the thresholds as values", async () => {
    const { DUPLICATE_SIMILARITY, LONG_FORM_MS } = await import("./catalogue");
    const { listRecommendations, RECOMMENDATIONS_POOL } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsCatalogueEnabled.mockResolvedValue(true);
    searchSonar.mockImplementation(referenceSonar);

    await listRecommendations(user);

    expect(searchSonar).toHaveBeenCalledTimes(1);
    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeIds: ["seed-1"],
        filter: {
          anchored: true,
          dismissed: false,
          duration_ms_max: LONG_FORM_MS,
          has_finding: false,
          is_duplicate: false,
          nearest_finding_score_max: DUPLICATE_SIMILARITY,
        },
        index: "tracks",
        topK: RECOMMENDATIONS_POOL,
      }),
    );
  });

  it("EQUIVALENCE: the sonar-routed catalogue is byte-for-byte the Turso catalogue", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    const tursoResult = await listRecommendations(user);

    isSonarRecsCatalogueEnabled.mockResolvedValue(true);
    searchSonar.mockImplementation(referenceSonar);

    const sonarResult = await listRecommendations(user);

    expect(tursoResult).not.toBeInstanceOf(Response);
    expect(sonarResult).not.toBeInstanceOf(Response);

    if (tursoResult instanceof Response || sonarResult instanceof Response) {
      return;
    }

    expect(tursoResult.catalogue.map((row) => row.trackId)).toEqual(EXPECTED_CATALOGUE);
    expect(sonarResult.catalogue.map((row) => row.trackId)).toEqual(
      tursoResult.catalogue.map((row) => row.trackId),
    );

    sonarResult.catalogue.forEach((row, index) => {
      const expected = tursoResult.catalogue[index];

      expect(expected).toBeDefined();
      expect({ ...row, similarity: 0 }).toEqual({ ...expected, similarity: 0 });
      expect(row.similarity).toBeCloseTo(expected?.similarity ?? -1, 6);
    });
  });

  it("EQUIVALENCE: every excluded class is absent from BOTH paths — dismissed, duplicate, display-duplicate, long-form, NULL-duration, un-anchored, and the coordinate-less straggler", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsCatalogueEnabled.mockResolvedValue(true);
    searchSonar.mockImplementation(referenceSonar);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    const ids = result.catalogue.map((row) => row.trackId);

    for (const excluded of [
      "ex-dismissed",
      "ex-duplicate",
      "ex-display-duplicate",
      "ex-long-form",
      "ex-exactly-long-form",
      "ex-unanchored",
      "ex-straggler",
      "find-1",
      "seed-1",
    ]) {
      expect(ids).not.toContain(excluded);
    }
  });

  it("`certified: false` would LEAK the coordinate-less straggler; `has_finding: false` excludes it", async () => {
    await seedWorld();

    const probes = [blend(axis(0), axis(9), 0)];
    const base = { index: "tracks", probes, topK: 50 } as const;

    const weaker = await referenceSonar({
      ...base,
      filter: {
        anchored: true,
        certified: false,
        dismissed: false,
        duration_ms_max: 15 * 60_000,
        is_duplicate: false,
        nearest_finding_score_max: 0.995,
      },
    });

    expect(weaker.map((match) => match.id)).toContain("ex-straggler");

    const correct = await referenceSonar({
      ...base,
      filter: {
        anchored: true,
        dismissed: false,
        duration_ms_max: 15 * 60_000,
        has_finding: false,
        is_duplicate: false,
        nearest_finding_score_max: 0.995,
      },
    });

    expect(correct.map((match) => match.id)).not.toContain("ex-straggler");
  });

  it("FLAG ON: a NULL sonar reply (unprovisioned/down/malformed) falls back to the Turso fold", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsCatalogueEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue(null);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.catalogue.map((row) => row.trackId)).toEqual(EXPECTED_CATALOGUE);
  });

  it("FLAG ON: an EMPTY sonar reply falls back to the Turso fold", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsCatalogueEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([]);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.catalogue.map((row) => row.trackId)).toEqual(EXPECTED_CATALOGUE);
  });

  it("a NULL `duration_ms` is unreachable — the column is NOT NULL, so that excluded class cannot be seeded", async () => {
    await seedWorld();

    await expect(
      db.execute({
        args: ["cat-near"],
        sql: `update tracks set duration_ms = null where track_id = ?`,
      }),
    ).rejects.toThrow(/NOT NULL/i);
  });

  it("the FINDINGS half is untouched by this flag — it rides its own", async () => {
    const { listRecommendations } = await import("./recommendations");
    const user = await seedWorld();

    isSonarRecsCatalogueEnabled.mockResolvedValue(true);
    searchSonar.mockImplementation(referenceSonar);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.findings.map((row) => row.trackId)).toEqual(["find-1"]);
  });
});
