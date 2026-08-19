import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMS } from "./embedding";
import { createIntegrationDb, seedEmbedding, seedTrack } from "./integration-db";

// The `/log` "more like this" surface's SONAR route, against REAL libSQL. The one thing a mocked
// `execute` could not prove is the load-bearing property here: with the flag ON, a finding whose
// `log_id` is NULL must NEVER reach `/log`, even if a stale sonar returns it. `findings.log_id` is
// nullable, and sonar's `certified` predates the tightening, so the hydrator re-asserts
// `log_id is not null` as defense-in-depth — proven here on real rows, not a mock of itself.

const isSonarArtistsEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarLogEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarMixEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarSonicEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./sonar", () => ({
  isSonarArtistsEnabled,
  isSonarLogEnabled,
  isSonarMixEnabled,
  isSonarSonicEnabled,
  searchSonar,
}));

const execute = vi.hoisted(() => vi.fn());
let db: Client;

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

import { TASTE_SHORTLIST } from "./mixability";
import { getMixableTracks, getSimilarFindings } from "./tracks";

/** A 1024-d MuQ-shaped vector pointing along axis 0 (the rest zero). */
function vector(a: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);
  values[0] = a;

  return values;
}

type Seed = { embedding: number[]; logId: string | null; trackId: string };

async function seed(rows: Seed[]): Promise<void> {
  for (const row of rows) {
    await seedTrack(db, { logId: row.logId, title: row.trackId, trackId: row.trackId });
    await seedEmbedding(db, row.trackId, row.embedding);
  }
}

beforeEach(async () => {
  db = await createIntegrationDb();
  execute.mockReset();
  execute.mockImplementation((query: unknown) => db.execute(query as never));
  isSonarLogEnabled.mockResolvedValue(true);
  isSonarMixEnabled.mockResolvedValue(false);
  searchSonar.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getSimilarFindings — the /log sonar route (dark)", () => {
  it("calls sonar with the certified pre-filter, the target excluded, and hydrates in sonar order", async () => {
    await seed([
      { embedding: vector(1), logId: "004.0.0A", trackId: "t_self" },
      { embedding: vector(1), logId: "004.1.1A", trackId: "t_a" },
      { embedding: vector(1), logId: "004.2.2B", trackId: "t_b" },
    ]);
    // sonar ranks t_b above t_a; the output must follow sonar, not the DB's insertion order.
    searchSonar.mockResolvedValue([
      { id: "t_b", score: 0.9 },
      { id: "t_a", score: 0.8 },
    ]);

    const findings = await getSimilarFindings("t_self");

    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeIds: ["t_self"],
        filter: { certified: true },
        index: "tracks",
        topK: 6,
      }),
    );
    expect(findings.map((finding) => finding.trackId)).toEqual(["t_b", "t_a"]);
  });

  it("DROPS a null-log_id finding a stale sonar returned — it never reaches /log", async () => {
    await seed([
      { embedding: vector(1), logId: "004.0.0A", trackId: "t_self" },
      { embedding: vector(1), logId: "004.1.1A", trackId: "t_good" },
      // A findings row WITHOUT a coordinate — the exact row the OFF path's `log_id is not null`
      // excludes. A sonar built before the turso.rs tightening could still rank it.
      { embedding: vector(1), logId: null, trackId: "t_nolog" },
    ]);
    searchSonar.mockResolvedValue([
      { id: "t_good", score: 0.9 },
      { id: "t_nolog", score: 0.85 },
    ]);

    const findings = await getSimilarFindings("t_self");

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_good"]);
    expect(findings.map((finding) => finding.trackId)).not.toContain("t_nolog");
  });

  it("the hydration query carries the `log_id is not null` guard", async () => {
    await seed([
      { embedding: vector(1), logId: "004.0.0A", trackId: "t_self" },
      { embedding: vector(1), logId: "004.1.1A", trackId: "t_a" },
    ]);
    searchSonar.mockResolvedValue([{ id: "t_a", score: 0.9 }]);

    await getSimilarFindings("t_self");

    const hydrationSql = execute.mock.calls
      .map(([query]) => (typeof query === "object" && query ? (query as { sql?: string }).sql : ""))
      .find((sql) => typeof sql === "string" && sql.includes("track_id in"));

    expect(hydrationSql).toContain("findings.log_id is not null");
  });

  it("falls back to the Turso scan when sonar returns empty", async () => {
    await seed([
      { embedding: vector(1), logId: "004.0.0A", trackId: "t_self" },
      { embedding: vector(1), logId: "004.1.1A", trackId: "t_a" },
    ]);
    searchSonar.mockResolvedValue([]);

    const findings = await getSimilarFindings("t_self");

    // The Turso vector scan still answers — same result the flag-OFF path returns today.
    expect(findings.map((finding) => finding.trackId)).toEqual(["t_a"]);
  });
});

// ── The `/mix` rail's SONAR route (dark) ──────────────────────────────────────────────────
//
// The rail's expensive half is the whole-archive `vector_distance_cos` candidate scan, and that
// is the ONLY half sonar replaces: it answers "the nearest key-compatible tracks to the chain's
// last one", and the same mixability engine ranks what comes back. These prove three things
// against real rows — that the request reproduces BOTH Turso predicates exactly (the named-move
// key spellings, and the chain exclusions with Log IDs resolved to the track ids sonar is keyed
// by), that the rail is RANKED rather than taken verbatim, and that every not-perfectly-well
// answer falls back to the Turso scan the flag-OFF path runs today.

/** A 1024-d vector whose cosine to `mixAxis(0)` is `cos`, the remainder on `spread`. */
function atCosine(cos: number, spread: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);

  values[0] = cos;
  values[spread] = Math.sqrt(Math.max(0, 1 - cos * cos));

  return values;
}

/** The unit basis vector on `index`. */
function mixAxis(index: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);

  values[index] = 1;

  return values;
}

type MixSeed = { embedding: number[]; key: string; logId: string; trackId: string };

async function seedMix(rows: MixSeed[]): Promise<void> {
  for (const row of rows) {
    await seedTrack(db, { logId: row.logId, title: row.trackId, trackId: row.trackId });
    await db.execute({
      args: [row.key, row.trackId],
      sql: `update tracks set key = ?1, bpm = 172,
                              features_json = '{"centroidHz":1000,"highRatio":0.1,"onsetRate":10}'
            where track_id = ?2`,
    });
    await seedEmbedding(db, row.trackId, row.embedding);
  }
}

/**
 * The rail's fixture: one target, two same-key candidates at different distances, one already
 * on the chain — plus ten far-away rows, because the sonic coverage gate wants eleven embedded
 * tracks in play before it trusts a cosine at all (`sonicGateOpen`).
 */
const MIX_ROWS: MixSeed[] = [
  { embedding: mixAxis(0), key: "A minor", logId: "300.1.1A", trackId: "t_tail" },
  { embedding: atCosine(0.9, 1), key: "A minor", logId: "301.1.1A", trackId: "t_near" },
  { embedding: atCosine(0.6, 2), key: "A minor", logId: "302.1.1A", trackId: "t_far" },
  { embedding: mixAxis(3), key: "A minor", logId: "303.1.1A", trackId: "t_chained" },
  ...Array.from({ length: 10 }, (_, index) => ({
    embedding: mixAxis(100 + index),
    key: "A minor",
    logId: `31${index}.1.1A`,
    trackId: `t_fill_${index}`,
  })),
];

/** What sonar answers with, once the two candidates under test are placed: the gate's fillers. */
const MIX_FILLER_MATCHES = Array.from({ length: 10 }, (_, index) => ({
  id: `t_fill_${index}`,
  score: 0,
}));

describe("getMixableTracks — the /mix sonar route (dark)", () => {
  it("does not touch sonar while the flag is OFF — the Turso scan still answers", async () => {
    await seedMix(MIX_ROWS);

    const rail = await getMixableTracks("t_tail", { limit: 12 });

    expect(searchSonar).not.toHaveBeenCalled();
    expect(rail.map((candidate) => candidate.trackId)).toContain("t_near");
  });

  it("asks sonar for the shortlist with the named-move keys and the chain excluded by track id", async () => {
    await seedMix(MIX_ROWS);
    isSonarMixEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([
      { id: "t_near", score: 0.9 },
      { id: "t_far", score: 0.6 },
    ]);

    await getMixableTracks("t_tail", { exclude: ["303.1.1A"], limit: 12 });

    const request = searchSonar.mock.calls[0]?.[0] as {
      excludeIds: string[];
      filter: { key_in: string[] };
      index: string;
      probes: number[][];
      topK: number;
    };

    expect(request.index).toBe("tracks");
    expect(request.topK).toBe(TASTE_SHORTLIST);
    expect(request.probes).toHaveLength(1);
    // The archive's stored key SPELLINGS, exactly as the Turso `key in (…)` pre-filter binds
    // them — sonar holds the same `tracks.key` string and compares it by equality.
    expect(request.filter.key_in).toEqual(["A minor"]);
    // The target, plus the chain — and the chain arrived as a COORDINATE, which sonar cannot
    // match, so it had to be resolved to its track id or the exclusion would have silently
    // evaporated.
    expect(request.excludeIds).toContain("t_tail");
    expect(request.excludeIds).toContain("t_chained");
    expect(request.excludeIds).not.toContain("303.1.1A");
  });

  it("ranks what sonar returned through the mixability engine, keeping the reason chip", async () => {
    await seedMix(MIX_ROWS);
    isSonarMixEnabled.mockResolvedValue(true);
    // Handed back in the WRONG order on purpose: the rail is ranked, never taken verbatim.
    searchSonar.mockResolvedValue([
      { id: "t_far", score: 0.6 },
      { id: "t_near", score: 0.9 },
      ...MIX_FILLER_MATCHES,
    ]);

    const rail = await getMixableTracks("t_tail", { limit: 12 });

    expect(rail.map((candidate) => candidate.trackId).slice(0, 2)).toEqual(["t_near", "t_far"]);
    expect(rail[0]?.reason).toMatchObject({ kind: expect.any(String) });
    // The DTO is the Turso path's, hydrated through the same select and mapper.
    expect(rail[0]?.certified).toBe(true);
    expect(rail[0]?.logId).toBe("301.1.1A");
  });

  it("falls back to the Turso scan when sonar answers null (off/unprovisioned/down)", async () => {
    await seedMix(MIX_ROWS);
    isSonarMixEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue(null);

    const rail = await getMixableTracks("t_tail", { limit: 12 });

    expect(rail.map((candidate) => candidate.trackId)).toContain("t_near");
  });

  it("falls back to the Turso scan when sonar answers empty", async () => {
    await seedMix(MIX_ROWS);
    isSonarMixEnabled.mockResolvedValue(true);
    searchSonar.mockResolvedValue([]);

    const rail = await getMixableTracks("t_tail", { limit: 12 });

    expect(rail.map((candidate) => candidate.trackId)).toContain("t_near");
  });

  it("never routes when the last track has no vector — there is no probe to send", async () => {
    await seedMix(MIX_ROWS);
    await seedEmbedding(db, "t_tail", null);
    isSonarMixEnabled.mockResolvedValue(true);

    const rail = await getMixableTracks("t_tail", { limit: 12 });

    expect(searchSonar).not.toHaveBeenCalled();
    expect(rail.map((candidate) => candidate.trackId)).toContain("t_near");
  });
});
