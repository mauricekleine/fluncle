import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMS } from "./embedding";
import { createIntegrationDb, seedTrack } from "./integration-db";

// The `/log` "more like this" surface's SONAR route, against REAL libSQL. The one thing a mocked
// `execute` could not prove is the load-bearing property here: with the flag ON, a finding whose
// `log_id` is NULL must NEVER reach `/log`, even if a stale sonar returns it. `findings.log_id` is
// nullable, and sonar's `certified` predates the tightening, so the hydrator re-asserts
// `log_id is not null` as defense-in-depth — proven here on real rows, not a mock of itself.

const isSonarArtistsEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarLogEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const isSonarSonicEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./sonar", () => ({
  isSonarArtistsEnabled,
  isSonarLogEnabled,
  isSonarSonicEnabled,
  searchSonar,
}));

const execute = vi.hoisted(() => vi.fn());
let db: Client;

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

import { getSimilarFindings } from "./tracks";

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
    await db.execute({
      args: [JSON.stringify(row.embedding), row.trackId],
      sql: `update tracks set embedding_blob = vector32(?1) where track_id = ?2`,
    });
  }
}

beforeEach(async () => {
  db = await createIntegrationDb();
  execute.mockReset();
  execute.mockImplementation((query: unknown) => db.execute(query as never));
  isSonarLogEnabled.mockResolvedValue(true);
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
