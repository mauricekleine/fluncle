import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import {
  applyFixtureSchema,
  auditFixtureCardinality,
  boundedFixtureCensusRequestCount,
  writeFixture,
} from "./fixture";
import { expectedFixtureIdentity, writeFixtureIdentity } from "./materialize";
import { type FixtureCounts, type ScaleProfile, getScaleManifest } from "./manifest";
import { type PerformanceExecutionProgress } from "./registry";
import {
  contractPhaseResourceBoundary,
  main,
  parseArguments,
  performanceProcessDeadlineMs,
  performanceWallDurationWarning,
  prepareFixture,
  writeHostedPerformanceProgress,
} from "./run";

const SMALL_COUNTS: FixtureCounts = {
  albums: 9,
  artists: 11,
  crawlFrontier: 41,
  enabledLabelTracks: 37,
  findings: 3,
  fullAnalysisBacklog: 0,
  labels: 7,
  musicbrainzIsrcBacklog: 17,
  pendingFrontier: 23,
  trackArtists: 53,
  trackEmbeddings: 19,
  tracks: 41,
  youtubeProvenanceBacklog: 13,
};

const clients: ReturnType<typeof createClient>[] = [];

function transportTimeout(): Error {
  const timeout = new Error("secret SQL, credentials, and topology");
  timeout.name = "TimeoutError";
  return timeout;
}

async function preseed(profile: ScaleProfile = "1x") {
  const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
  clients.push(client);
  await applyFixtureSchema(client);
  await writeFixture(client, profile, { counts: SMALL_COUNTS });
  expect((await auditFixtureCardinality(client, SMALL_COUNTS)).passed).toBe(true);
  await writeFixtureIdentity(client, expectedFixtureIdentity(profile, SMALL_COUNTS));
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
});

describe("database performance runner bootstrap", () => {
  it("enables aggregate wall warnings only for hosted replay", () => {
    expect(performanceWallDurationWarning("hosted")).toBe(true);
    expect(performanceWallDurationWarning("local")).toBe(false);
  });

  it("adds a scale-matched hosted bootstrap allowance without changing local caps", () => {
    for (const [profile, exactProfileDeadlineMs, censusRequests] of [
      ["1x", 5 * 60_000, 92],
      ["2x", 8 * 60_000, 126],
      ["4x", 12 * 60_000, 205],
    ] as const) {
      expect(performanceProcessDeadlineMs({ fullFixture: false, hosted: false, profile })).toBe(
        2 * 60_000,
      );
      expect(performanceProcessDeadlineMs({ fullFixture: true, hosted: false, profile })).toBe(
        exactProfileDeadlineMs,
      );
      const hostedDeadlineMs = performanceProcessDeadlineMs({
        fullFixture: false,
        hosted: true,
        profile,
      });
      expect(hostedDeadlineMs).toBe(exactProfileDeadlineMs * 2);
      expect(hostedDeadlineMs - exactProfileDeadlineMs).toBeGreaterThan(0);
      expect(boundedFixtureCensusRequestCount(getScaleManifest(profile).counts)).toBe(
        censusRequests,
      );
    }
  });

  it("validates the hosted preseed flag matrix before any credential path", () => {
    expect(() => parseArguments(["--hosted", "--operator-approved"])).toThrow(
      "--hosted requires --preseeded-fixture",
    );
    expect(() => parseArguments(["--preseeded-fixture"])).toThrow(
      "--preseeded-fixture requires --hosted",
    );
    expect(() =>
      parseArguments(["--hosted", "--operator-approved", "--preseeded-fixture", "--full-fixture"]),
    ).toThrow("cannot combine with --full-fixture");
    expect(
      parseArguments(["--hosted", "--operator-approved", "--preseeded-fixture"]),
    ).toMatchObject({ hosted: true, preseededFixture: true });
  });

  it("rejects unknown contracts before hosted credentials, clients, or bootstrap", async () => {
    const resolveReplay = vi.fn(() => {
      throw new Error("hosted credential path reached");
    });

    await expect(
      main(
        {
          contractIds: ["unknown.contract"],
          fullFixture: false,
          hosted: true,
          list: false,
          operatorApproved: true,
          preseededFixture: true,
          profile: "1x",
        },
        { resolveReplay },
      ),
    ).rejects.toThrow("unknown performance contract: unknown.contract");
    expect(resolveReplay).not.toHaveBeenCalled();
  });

  it("verifies a preseeded fixture using only read batches", async () => {
    const client = await preseed();
    const originalBatch = client.batch.bind(client);
    const originalExecute = client.execute.bind(client);
    const batches: Array<{ mode: string | undefined; sql: string[] }> = [];
    const executions: string[] = [];
    const progress: PerformanceExecutionProgress[] = [];
    vi.spyOn(client, "batch").mockImplementation(async (statements, mode) => {
      batches.push({
        mode,
        sql: statements.map((statement) =>
          typeof statement === "string" ? statement : statement.sql,
        ),
      });
      return originalBatch(statements, mode);
    });
    vi.spyOn(client, "execute").mockImplementation(async (statement) => {
      executions.push(typeof statement === "string" ? statement : statement.sql);
      return originalExecute(statement);
    });

    const bootstrap = await prepareFixture(client, {
      counts: SMALL_COUNTS,
      hosted: true,
      onProgress: (event) => progress.push(event),
      profile: "1x",
    });

    expect(bootstrap.mode).toBe("preseeded-verified");
    expect(bootstrap.written).toBeNull();
    expect(bootstrap.writeDurationMs).toBeNull();
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.mode === "read")).toBe(true);
    expect(batches.every((batch) => batch.sql.length === 1)).toBe(true);
    expect(progress).toEqual([
      { phase: "fixture-identity" },
      ...batches.map((_, index) => ({
        iteration: index + 1,
        iterations: batches.length,
        phase: "fixture-census" as const,
      })),
    ]);
    expect([...batches.flatMap((batch) => batch.sql), ...executions].join("\n")).not.toMatch(
      /\b(?:create|drop|insert|update|delete)\b/i,
    );
  });

  it("starts isolated hosted contract budgets after bootstrap", () => {
    const hosted = contractPhaseResourceBoundary({
      databaseProcessIsolated: true,
      fixtureResource: { heapUsedBytes: 30, rssBytes: 40 },
      fixtureWriteCompletedAtMs: 200,
      initialResource: { heapUsedBytes: 100, rssBytes: 200 },
      runStartedAtMs: 100,
    });
    const embedded = contractPhaseResourceBoundary({
      databaseProcessIsolated: false,
      fixtureResource: { heapUsedBytes: 30, rssBytes: 40 },
      fixtureWriteCompletedAtMs: 200,
      initialResource: { heapUsedBytes: 100, rssBytes: 200 },
      runStartedAtMs: 100,
    });

    expect(hosted).toEqual({
      initial: { heapUsedBytes: 30, rssBytes: 40 },
      startedAtMs: 200,
    });
    expect(embedded).toEqual({
      initial: { heapUsedBytes: 100, rssBytes: 200 },
      startedAtMs: 100,
    });
  });

  it("writes hosted progress to stderr without contaminating JSON stdout", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      writeHostedPerformanceProgress({
        contractId: "route.progress-pin",
        iteration: 2,
        iterations: 4,
        phase: "measured-iteration",
      });

      expect(stderr).toHaveBeenCalledWith(
        "[db-performance] phase=measured-iteration contract=route.progress-pin iteration=2/4\n",
      );
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it("adds safe fixture phase context to hosted identity and census timeouts", async () => {
    const identityClient = await preseed();
    const identityProgress: PerformanceExecutionProgress[] = [];
    vi.spyOn(identityClient, "execute").mockRejectedValue(transportTimeout());
    await expect(
      prepareFixture(identityClient, {
        counts: SMALL_COUNTS,
        hosted: true,
        onProgress: (event) => identityProgress.push(event),
        profile: "1x",
      }),
    ).rejects.toMatchObject({
      message: "[db-performance] phase=fixture-identity request timed out",
      name: "TimeoutError",
    });
    expect(identityProgress).toEqual([{ phase: "fixture-identity" }]);

    const censusClient = await preseed();
    const censusProgress: PerformanceExecutionProgress[] = [];
    vi.spyOn(censusClient, "batch").mockRejectedValue(transportTimeout());
    await expect(
      prepareFixture(censusClient, {
        counts: SMALL_COUNTS,
        hosted: true,
        onProgress: (event) => censusProgress.push(event),
        profile: "1x",
      }),
    ).rejects.toMatchObject({
      message: "[db-performance] phase=fixture-census request timed out",
      name: "TimeoutError",
    });
    expect(censusProgress).toEqual([
      { phase: "fixture-identity" },
      {
        iteration: 1,
        iterations: boundedFixtureCensusRequestCount(SMALL_COUNTS),
        phase: "fixture-census",
      },
    ]);
  });

  it("rejects missing identity and wrong profile before contract execution", async () => {
    const missing = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    clients.push(missing);
    await applyFixtureSchema(missing);
    await writeFixture(missing, "1x", { counts: SMALL_COUNTS });
    await expect(
      prepareFixture(missing, { counts: SMALL_COUNTS, hosted: true, profile: "1x" }),
    ).rejects.toThrow("identity is missing");

    const wrongProfile = await preseed("1x");
    await expect(
      prepareFixture(wrongProfile, { counts: SMALL_COUNTS, hosted: true, profile: "2x" }),
    ).rejects.toThrow("identity mismatch: profile");

    const wrongFormat = await preseed("1x");
    await wrongFormat.execute(
      "update perf_fixture_identity set format_version = format_version + 1 where singleton = 1",
    );
    await expect(
      prepareFixture(wrongFormat, { counts: SMALL_COUNTS, hosted: true, profile: "1x" }),
    ).rejects.toThrow("identity mismatch: formatVersion");
  });

  it("aborts on post-import census drift before returning a runnable bootstrap", async () => {
    const client = await preseed();
    await client.execute("delete from perf_tracks where id = 'synthetic-track-000000000'");

    await expect(
      prepareFixture(client, { counts: SMALL_COUNTS, hosted: true, profile: "1x" }),
    ).rejects.toThrow("table perf_tracks: expected 41, observed 40");
  });
});
