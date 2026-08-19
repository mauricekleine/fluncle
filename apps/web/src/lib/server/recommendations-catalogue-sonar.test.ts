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

// THE /recommendations CATALOGUE SCAN'S SONAR ROUTE (dark, DEFAULT OFF — `sonar_recs_catalogue_enabled`),
// against the REAL schema on a real libSQL engine.
//
// THE ACCEPTANCE BAR HERE IS EQUIVALENCE, NOT "IT RUNS". Routing this scan is only legitimate if
// sonar returns the SAME rows the Turso fold returns — REC_ELIGIBLE_WHERE has seven clauses and
// four of them are UNBOUNDED sets, so a mapping that quietly drops one cannot be caught by an
// assertion that the page merely rendered. So this suite does not mock sonar with a canned answer:
// it stands up a REFERENCE ENGINE (`referenceSonar`) that reimplements apps/sonar's filter
// semantics — including the two OPPOSITE null rules — over the same fixture rows, and asserts the
// routed page is byte-for-byte the un-routed page. If the Worker's filter ever loses a clause, the
// reference engine faithfully returns the excluded row and the comparison fails.
//
// The fixture world holds ONE ROW OF EACH EXCLUDED CLASS, including the trap the whole slice turns
// on: a COORDINATE-LESS STRAGGLER (a findings row whose `log_id` is NULL). It passes sonar's
// `certified: false` and must be excluded by `has_finding: false` — the two are different facts,
// and only the second one is the negation `f.track_id is null` actually means.
//
// ONE CLASS IS DELIBERATELY ABSENT AND CANNOT BE SEEDED: a NULL `duration_ms`. `tracks.duration_ms`
// is NOT NULL in the schema, so the row simply cannot exist here — see the test at the bottom that
// pins that. The engine still has to get the null rule right (a value outside `u32` reads as
// missing), and it is asserted where such an entry CAN be constructed: apps/sonar's own unit tests
// (`duration_ms_max_excludes_a_null_duration`, `the_two_null_rules_are_deliberately_opposite`).
// The NULL `nearest_finding_score` half of the asymmetry IS reachable and is seeded below.

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

// ── The fixture vectors ───────────────────────────────────────────────────────────────────────

/** A unit vector along one axis — an "artificial genre" fixture vectors can aim at. */
function axis(index: number): number[] {
  const vector = Array.from<number>({ length: EMBEDDING_DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

/** Normalize, so every fixture vector is unit-length like a real MuQ vector. */
function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

/** A vector `weight` of the way from `from` toward `toward` — a controlled near-neighbour. */
function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

// ── The reference sonar engine ────────────────────────────────────────────────────────────────

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

/**
 * Load the `tracks` index exactly as apps/sonar's loader does (`TRACKS_SQL`): one entry per
 * EMBEDDED track — index membership IS the inner join to `track_embeddings` — carrying the raw
 * metadata, with `certified` and `has_finding` read off the SAME single left join as two
 * DIFFERENT facts (a Log ID vs. a row).
 */
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

    // A row whose blob does not decode is SKIPPED, never a throw — the loader's posture.
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

/**
 * apps/sonar's `passes_filter`, clause for clause — INCLUDING the two null rules that are
 * deliberately opposite:
 *
 *   - `nearest_finding_score_max`: a NULL score PASSES (`score is null or score < x`).
 *   - `duration_ms_max`: a NULL duration FAILS (`duration_ms < x`, and `NULL < x` is NULL).
 *
 * Both bounds are EXCLUSIVE, unlike the inclusive BPM pair.
 */
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

/** Cosine similarity between two vectors (both normalized first, as the engine does on load). */
function cosine(a: number[], b: number[]): number {
  const left = unit(a);
  const right = unit(b);
  let dot = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }

  return dot;
}

/**
 * The engine: filter, exclude, score by MAX dot over probes (the nearest-probe fold, never an
 * average), sort descending, cut at `topK`. Deterministic — no approximation, like the real one.
 */
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

// ── The fixture world ─────────────────────────────────────────────────────────────────────────

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

/** The write the embed pipeline performs: validated JSON → the ranked F32_BLOB. */
async function embed(trackId: string, vector: number[]): Promise<void> {
  await seedEmbedding(db, trackId, vector);
}

/**
 * One catalogue row at a controlled distance from the seed. Every row gets its OWN artist so the
 * diversity decay is order-preserving here and the comparison stays about the SCAN, not the decay.
 */
async function seedRow(trackId: string, weight: number, durationMs = 270_000): Promise<void> {
  await seedCatalogueTrack(db, {
    artists: [`Artist ${trackId}`],
    durationMs,
    title: `Track ${trackId}`,
    trackId,
  });
  await embed(trackId, blend(axis(0), axis(9), weight));
}

/**
 * The fixture world: five ELIGIBLE catalogue rows, and one row of EACH excluded class — dismissed,
 * duplicate-marked, display-duplicate (score ≥ DUPLICATE_SIMILARITY), long-form, NULL-duration,
 * un-anchored, a coordinate-less straggler, and a certified finding. Every row sits at its own
 * distance from the seed, so the ranking has one unambiguous answer.
 */
async function seedWorld(): Promise<PublicUser> {
  const { saveRecSeed } = await import("./recommendations");
  const user = publicUser("user-catalogue-sonar");

  // ELIGIBLE — the five rows both paths must return, in this order.
  await seedRow("cat-near", 0.1);
  await seedRow("cat-low-score", 0.12);
  await db.execute({
    args: ["cat-low-score"],
    sql: `update tracks set nearest_finding_score = 0.5 where track_id = ?`,
  });
  await seedRow("cat-null-score", 0.14);
  await seedRow("cat-mid", 0.2);
  await seedRow("cat-far", 0.3);

  // EXCLUDED, one per class — each closer to the seed than at least one eligible row, so a
  // dropped clause shows up as a LEAKED ROW near the top rather than a silent tail difference.
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
  // Exactly ON the veto: `duration_ms < LONG_FORM_MS` is EXCLUSIVE, so this row is out too, and
  // sonar's `duration_ms_max` has to be exclusive as well or the two paths diverge by one row.
  await seedRow("ex-exactly-long-form", 0.18, 15 * 60_000);

  await seedRow("ex-unanchored", 0.19);
  await db.execute({
    args: ["ex-unanchored"],
    sql: `update tracks set spotify_uri = null, spotify_url = null where track_id = ?`,
  });

  // THE TRAP: a findings row with NO Log ID. `certified: false`, `has_finding: true`.
  await seedTrack(db, {
    artists: ["Artist ex-straggler"],
    logId: null,
    title: "Track ex-straggler",
    trackId: "ex-straggler",
  });
  await embed("ex-straggler", blend(axis(0), axis(9), 0.21));

  // A certified finding, so the findings half of the engine has something to return.
  await seedTrack(db, {
    artists: ["Artist find-1"],
    logId: "001.1.1A",
    title: "Track find-1",
    trackId: "find-1",
  });
  await embed("find-1", blend(axis(0), axis(9), 0.25));

  // The seed itself is a catalogue row aimed straight at axis 0.
  await seedRow("seed-1", 0);
  await saveRecSeed(user, { trackId: "seed-1" });

  return user;
}

/** The five eligible rows, nearest first — the one right answer for this fixture world. */
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

    // Exactly one call — the findings flag is off, so the findings slots stay on Turso.
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

    // Not just the ids: the whole DTO, similarity included (the two paths differ only in float
    // width, so the numbers are compared to six places and everything else exactly).
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

  /**
   * The `certified` vs `has_finding` trap, proven on the engine itself rather than inferred: the
   * SAME fixture world, the SAME filter except for that one field, and the coordinate-less
   * straggler walks straight in. This is why the Worker sends `has_finding: false`.
   */
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

  /**
   * The other half of the null asymmetry, and why it is not in the fixture world above: a
   * `tracks` row CANNOT have a NULL duration. `duration_ms` is NOT NULL in the schema, so the
   * class is unreachable from the database, and the engine-side rule (a missing duration FAILS
   * `duration_ms_max`) is pinned in apps/sonar's own tests instead. Asserted rather than assumed,
   * because if the column ever became nullable this fixture world would owe that row.
   */
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

    // The certified finding, ranked by the Turso fold — the findings flag stayed off, and the
    // coordinate-less straggler is not a finding either.
    expect(result.findings.map((row) => row.trackId)).toEqual(["find-1"]);
  });
});
