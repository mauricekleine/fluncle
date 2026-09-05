import { type Client, createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

import {
  FIXTURE_CENSUS_QUERY_CHUNK_SIZE,
  FIXTURE_IDENTITY_TABLE,
  FIXTURE_TABLES,
  HOSTED_FIXTURE_CENSUS_ROW_LIMIT,
  applyFixtureSchema,
  assertBoundedFixtureDistributionCoverage,
  auditFixtureCardinality,
  boundedFixtureCensusRequestCount,
  expectedFixtureTableCardinalities,
  fixtureFingerprint,
  generateFixture,
  indexFixtureCardinalities,
  projectionFixtureCardinalities,
  publicAggregateFixtureBuckets,
  releaseDateForIndex,
  resetFixture,
  writeFixture,
} from "./fixture";
import { getScaleManifest, type FixtureCounts } from "./manifest";

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

async function scalar(client: ReturnType<typeof createClient>, sql: string): Promise<number> {
  const result = await client.execute(sql);

  return Number(result.rows[0]?.n ?? -1);
}

describe("synthetic database performance fixture", () => {
  it("streams bounded chunks made only from stable synthetic values", async () => {
    const counts = Object.fromEntries(FIXTURE_TABLES.map((table) => [table, 0]));
    let chunks = 0;

    for await (const chunk of generateFixture("1x", { chunkSize: 7, counts: SMALL_COUNTS })) {
      chunks += 1;
      expect(chunk.statements.length).toBeLessThanOrEqual(7);
      counts[chunk.table] += chunk.statements.length;

      for (const statement of chunk.statements) {
        const publicValues = statement.args.filter(
          (value): value is string => typeof value === "string",
        );
        expect(publicValues.join(" ")).not.toMatch(
          /spotify:|https?:|\bprod(?:uction)?\b|\bfluncle\b/i,
        );
      }
    }

    expect(chunks).toBeGreaterThan(8);
    expect(counts).toEqual({
      due_work: SMALL_COUNTS.youtubeProvenanceBacklog + SMALL_COUNTS.musicbrainzIsrcBacklog,
      perf_albums: SMALL_COUNTS.albums,
      perf_artist_rules: SMALL_COUNTS.artists,
      perf_artists: SMALL_COUNTS.artists,
      perf_crawl_frontier: SMALL_COUNTS.crawlFrontier,
      perf_findings: SMALL_COUNTS.findings,
      perf_galaxies: 0,
      perf_labels: SMALL_COUNTS.labels,
      perf_track_artists: SMALL_COUNTS.trackArtists,
      perf_track_embeddings: SMALL_COUNTS.trackEmbeddings,
      perf_tracks: SMALL_COUNTS.tracks,
      ...indexFixtureCardinalities(SMALL_COUNTS),
      ...projectionFixtureCardinalities(SMALL_COUNTS),
    });
  });

  it("is byte-deterministic for the same inputs and changes with the manifest", async () => {
    const first = await fixtureFingerprint("1x", { chunkSize: 5, counts: SMALL_COUNTS });
    const second = await fixtureFingerprint("1x", { chunkSize: 7, counts: SMALL_COUNTS });
    const changed = await fixtureFingerprint("1x", {
      chunkSize: 5,
      counts: { ...SMALL_COUNTS, pendingFrontier: SMALL_COUNTS.pendingFrontier + 1 },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("keeps Contract D source growth exact while projection buckets and documents stay bounded", () => {
    const baselineCounts = getScaleManifest("1x").counts;
    const baseline = projectionFixtureCardinalities(baselineCounts);
    const baselineIndex = indexFixtureCardinalities(baselineCounts);
    const growing = [
      "perf_artist_qualification",
      "perf_artist_qualification_contributions",
      "perf_crawl_due_work",
      "perf_public_aggregate_membership",
    ] as const;
    const bounded = [
      "perf_artist_qualification_state",
      "perf_crawl_projection_repairs",
      "perf_hub_page_anchor_validity",
      "perf_hub_page_anchors",
      "perf_projection_repairs",
      "perf_public_aggregate_counts",
      "perf_public_aggregate_state",
    ] as const;

    for (const [profile, multiplier] of [
      ["2x", 2],
      ["4x", 4],
    ] as const) {
      const scaled = projectionFixtureCardinalities(getScaleManifest(profile).counts);

      for (const key of growing) {
        expect(scaled[key], `${profile} ${key}`).toBe(baseline[key] * multiplier);
      }
      for (const key of bounded) {
        expect(scaled[key], `${profile} ${key}`).toBe(baseline[key]);
      }

      const scaledIndex = indexFixtureCardinalities(getScaleManifest(profile).counts);
      for (const key of Object.keys(baselineIndex) as (keyof typeof baselineIndex)[]) {
        const expected =
          key === "perf_database_admission_contenders"
            ? baselineIndex[key]
            : baselineIndex[key] * multiplier;
        expect(scaledIndex[key], `${profile} ${key}`).toBe(expected);
      }
    }
  });

  it("preserves the release-year histogram while distributing the fresh year across real dates", () => {
    const counts = getScaleManifest("1x").counts;
    const buckets = publicAggregateFixtureBuckets(counts).releaseDate;
    const freshCount = buckets[0]?.count ?? 0;
    const freshDates = Array.from({ length: freshCount }, (_, index) =>
      releaseDateForIndex(index, buckets),
    );
    const presentDates = freshDates.filter((date): date is string => date !== null);

    expect(freshCount).toBe(28_000);
    expect(presentDates).toHaveLength(freshCount);
    expect(presentDates[0]).toBe("2026-01-01");
    expect(presentDates.at(-1)).toBe("2026-12-31");
    expect(new Set(presentDates).size).toBe(365);
    expect(presentDates.every((date) => date.startsWith("2026-"))).toBe(true);
    expect(presentDates).toEqual([...presentDates].sort());
    expect(releaseDateForIndex(freshCount, buckets)).toBe("2025");
  });

  it("materializes exact fan-out, null, selectivity, and backlog counts locally", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });
      const census = await auditFixtureCardinality(client, SMALL_COUNTS);

      expect(census).toEqual({
        distributions: { expected: SMALL_COUNTS, observed: SMALL_COUNTS },
        mismatches: [],
        passed: true,
        tables: {
          expected: expectedFixtureTableCardinalities(SMALL_COUNTS),
          observed: expectedFixtureTableCardinalities(SMALL_COUNTS),
        },
      });

      expect(await scalar(client, "select count(*) as n from perf_tracks")).toBe(41);
      expect(await scalar(client, "select count(*) as n from perf_track_artists")).toBe(53);
      expect(await scalar(client, "select count(*) as n from perf_track_embeddings")).toBe(19);
      expect(await scalar(client, "select count(*) as n from perf_findings")).toBe(3);
      const collisionArtists = await client.execute(
        `select name, mbid from perf_artists where id in
          ('synthetic-artist-000000000', 'synthetic-artist-000000001',
           'synthetic-artist-000000002') order by id`,
      );
      expect(collisionArtists.rows).toEqual([
        { mbid: "synthetic-mbid-identity", name: "Synthetic Identity" },
        { mbid: null, name: "Synthetic Collision" },
        { mbid: "synthetic-mbid-collision", name: "Synthetic Collision" },
      ]);
      const collisionTracks = await client.execute(
        `select id, artists_json, is_catalogue from perf_tracks
         where id in ('synthetic-track-000000000', 'synthetic-track-000000003',
                      'synthetic-track-000000004') order by id`,
      );
      expect(collisionTracks.rows).toEqual([
        {
          artists_json: '["Synthetic Identity"]',
          id: "synthetic-track-000000000",
          is_catalogue: 1,
        },
        {
          artists_json: '["Synthetic Collision","Synthetic Identity","Synthetic Identity"]',
          id: "synthetic-track-000000003",
          is_catalogue: 1,
        },
        {
          artists_json: '["Synthetic Alias"]',
          id: "synthetic-track-000000004",
          is_catalogue: 1,
        },
      ]);
      expect(
        await scalar(client, "select count(*) as n from perf_tracks where label_scope = 'enabled'"),
      ).toBe(37);
      expect(
        await scalar(client, "select count(*) as n from perf_tracks where youtube_backlog = 1"),
      ).toBe(13);
      expect(
        await scalar(
          client,
          "select count(*) as n from perf_tracks where musicbrainz_isrc_backlog = 1",
        ),
      ).toBe(17);
      expect(
        await scalar(
          client,
          "select count(*) as n from perf_tracks where full_analysis_backlog = 1",
        ),
      ).toBe(0);
      expect(
        await scalar(
          client,
          "select count(*) as n from perf_crawl_frontier where state = 'pending'",
        ),
      ).toBe(23);
      expect(await scalar(client, "select count(*) as n from perf_crawl_due_work")).toBe(
        projectionFixtureCardinalities(SMALL_COUNTS).perf_crawl_due_work,
      );
      expect(
        await scalar(client, "select count(*) as n from perf_artist_rules where verdict = 'allow'"),
      ).toBe(3);
      expect(await scalar(client, "select count(*) as n from perf_artist_qualification")).toBe(11);
      expect(
        await scalar(client, "select count(*) as n from perf_artist_qualification_contributions"),
      ).toBe(53);
      expect(
        await scalar(client, "select count(*) as n from perf_public_aggregate_membership"),
      ).toBe(41);
      expect(await scalar(client, "select count(*) as n from perf_public_aggregate_counts")).toBe(
        10,
      );
      expect(await scalar(client, "select count(*) as n from perf_hub_page_anchors")).toBe(1);
      expect(await scalar(client, "select count(*) as n from perf_hub_page_anchor_validity")).toBe(
        1,
      );
      expect(await scalar(client, "select count(*) as n from due_work where state = 'ready'")).toBe(
        30,
      );
    } finally {
      client.close();
    }
  });

  it("fails the post-write census when committed rows differ from the exact fixture", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });
      await client.execute("delete from perf_tracks where id = 'synthetic-track-000000000'");
      const census = await auditFixtureCardinality(client, SMALL_COUNTS);

      expect(census.passed).toBe(false);
      expect(census.mismatches).toEqual(
        expect.arrayContaining([
          "table perf_tracks: expected 41, observed 40",
          "distribution tracks: expected 41, observed 40",
        ]),
      );
    } finally {
      client.close();
    }
  });

  it("splits the complete census into bounded remote-safe read batches", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });
      const originalBatch = client.batch.bind(client);
      const censusBatchSizes: number[] = [];
      vi.spyOn(client, "batch").mockImplementation(async (statements, mode) => {
        censusBatchSizes.push(statements.length);
        expect(mode).toBe("read");
        return originalBatch(statements, mode);
      });

      expect((await auditFixtureCardinality(client, SMALL_COUNTS)).passed).toBe(true);
      expect(censusBatchSizes.length).toBeGreaterThan(1);
      expect(Math.max(...censusBatchSizes)).toBe(FIXTURE_CENSUS_QUERY_CHUNK_SIZE);
    } finally {
      client.close();
    }
  });

  it("can issue each census statement as one remote request with fixed progress", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });
      const originalBatch = client.batch.bind(client);
      const censusBatchSizes: number[] = [];
      const progress: Array<{ request: number; requests: number }> = [];
      vi.spyOn(client, "batch").mockImplementation(async (statements, mode) => {
        censusBatchSizes.push(statements.length);
        return originalBatch(statements, mode);
      });

      expect(
        (
          await auditFixtureCardinality(client, SMALL_COUNTS, {
            onRequest: (request, requests) => progress.push({ request, requests }),
            statementsPerRequest: 1,
          })
        ).passed,
      ).toBe(true);
      expect(censusBatchSizes.every((size) => size === 1)).toBe(true);
      expect(progress).toHaveLength(censusBatchSizes.length);
      expect(progress).toEqual(
        Array.from({ length: censusBatchSizes.length }, (_, index) => ({
          request: index + 1,
          requests: censusBatchSizes.length,
        })),
      );
    } finally {
      client.close();
    }
  });

  it("bounds hosted census reads by deterministic windows with fixed request progress", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });
      const originalBatch = client.batch.bind(client);
      const statements: Array<{ args: unknown[]; sql: string }> = [];
      const progress: Array<{ request: number; requests: number }> = [];
      vi.spyOn(client, "batch").mockImplementation(async (batch, mode) => {
        expect(mode).toBe("read");
        expect(batch).toHaveLength(1);
        const statement = batch[0];
        expect(typeof statement).not.toBe("string");
        if (typeof statement !== "string" && statement !== undefined) {
          statements.push({ args: [...statement.args], sql: statement.sql });
        }
        return originalBatch(batch, mode);
      });

      const census = await auditFixtureCardinality(client, SMALL_COUNTS, {
        maxRowsPerStatement: 10,
        onRequest: (request, requests) => progress.push({ request, requests }),
        statementsPerRequest: 1,
      });

      expect(census.passed).toBe(true);
      expect(statements).toHaveLength(
        boundedFixtureCensusRequestCount(SMALL_COUNTS, { maxRowsPerStatement: 10 }),
      );
      expect(progress).toEqual(
        statements.map((_, index) => ({ request: index + 1, requests: statements.length })),
      );
      expect(statements.map((statement) => statement.sql).join("\n")).not.toMatch(
        /\b(?:create|drop|insert|update|delete)\b/i,
      );

      const ranges = statements.filter((statement) =>
        /rowid between \? and \?/.test(statement.sql),
      );
      expect(ranges.length).toBeGreaterThan(0);
      for (const statement of ranges) {
        const [start, end] = statement.args;
        expect(typeof start).toBe("number");
        expect(typeof end).toBe("number");
        if (typeof start === "number" && typeof end === "number") {
          expect(start).toBeGreaterThan(0);
          expect(end).toBeGreaterThanOrEqual(start);
          expect(end - start + 1).toBeLessThanOrEqual(10);
        }
        expect(statement.sql).toContain("not indexed");
      }

      const trackTableRanges = ranges
        .filter(
          (statement) =>
            statement.sql.includes("from perf_tracks not indexed") &&
            !statement.sql.includes(" and label_scope") &&
            !statement.sql.includes(" and full_analysis_backlog") &&
            !statement.sql.includes(" and musicbrainz_isrc_backlog") &&
            !statement.sql.includes(" and youtube_backlog"),
        )
        .map((statement) => statement.args);
      expect(trackTableRanges).toEqual([
        [1, 10],
        [11, 20],
        [21, 30],
        [31, 40],
        [41, 41],
      ]);

      const sentinels = statements.filter((statement) => statement.sql.includes("as underflow"));
      expect(sentinels).toHaveLength(FIXTURE_TABLES.length);
      expect(sentinels.every((statement) => statement.sql.includes("as overflow"))).toBe(true);
      expect(sentinels.every((statement) => !/\bor\b/i.test(statement.sql))).toBe(true);

      const embeddingRanges = statements.filter((statement) =>
        statement.sql.includes("from perf_track_embeddings where track_id between ? and ?"),
      );
      expect(embeddingRanges).toEqual([
        {
          args: ["synthetic-track-000000000", "synthetic-track-000000009"],
          sql: "select count(*) as count from perf_track_embeddings where track_id between ? and ?",
        },
        {
          args: ["synthetic-track-000000010", "synthetic-track-000000019"],
          sql: "select count(*) as count from perf_track_embeddings where track_id between ? and ?",
        },
        {
          args: ["synthetic-track-000000020", "synthetic-track-000000029"],
          sql: "select count(*) as count from perf_track_embeddings where track_id between ? and ?",
        },
        {
          args: ["synthetic-track-000000030", "synthetic-track-000000039"],
          sql: "select count(*) as count from perf_track_embeddings where track_id between ? and ?",
        },
        {
          args: ["synthetic-track-000000040", "synthetic-track-000000040"],
          sql: "select count(*) as count from perf_track_embeddings where track_id between ? and ?",
        },
      ]);
      expect(
        statements.some(
          (statement) =>
            statement.sql.includes("from perf_track_embeddings not indexed") &&
            statement.sql.includes("rowid between"),
        ),
      ).toBe(false);
    } finally {
      client.close();
    }
  });

  it("pins exact hosted census request counts at every release scale", () => {
    expect(
      Object.fromEntries(
        (["1x", "2x", "4x"] as const).map((profile) => [
          profile,
          boundedFixtureCensusRequestCount(getScaleManifest(profile).counts),
        ]),
      ),
    ).toEqual({ "1x": 92, "2x": 126, "4x": 205 });
  });

  it("maps exact 1x request 17 to a covering embedding-index count", async () => {
    let request = 0;
    let seventeenthStatement: { args: unknown[]; sql: string } | undefined;
    const client = {
      batch: vi.fn(async (statements: Array<{ args: unknown[]; sql: string }>) => {
        request += 1;
        const statement = statements[0];
        if (statement === undefined) {
          throw new Error("test batch omitted its statement");
        }
        if (request === 17) {
          seventeenthStatement = statement;
          throw new Error("request 17 captured");
        }
        if (statement.sql.includes("as underflow")) {
          return [{ rows: [{ overflow: 0, underflow: 0 }] }];
        }
        const [start, end] = statement.args;
        if (typeof start !== "number" || typeof end !== "number") {
          throw new Error("a pre-17 range did not use numeric rowids");
        }
        return [{ rows: [{ count: end - start + 1 }] }];
      }),
    } as unknown as Client;

    await expect(
      auditFixtureCardinality(client, getScaleManifest("1x").counts, {
        maxRowsPerStatement: HOSTED_FIXTURE_CENSUS_ROW_LIMIT,
        statementsPerRequest: 1,
      }),
    ).rejects.toThrow("request 17 captured");
    expect(seventeenthStatement).toEqual({
      args: ["synthetic-track-000000000", "synthetic-track-000049999"],
      sql: "select count(*) as count from perf_track_embeddings where track_id between ? and ?",
    });
  });

  it("fails closed when bounded distribution sources overlap or omit a manifest key", async () => {
    expect(() =>
      assertBoundedFixtureDistributionCoverage(SMALL_COUNTS, {
        filtered: ["enabledLabelTracks", "tracks"],
        table: ["tracks"],
      }),
    ).toThrow(
      "fixture census distribution partition invalid: missing [albums, artists, crawlFrontier, findings, fullAnalysisBacklog, labels, musicbrainzIsrcBacklog, pendingFrontier, trackArtists, trackEmbeddings, youtubeProvenanceBacklog]; duplicated [tracks]; unexpected []",
    );

    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    const batch = vi.spyOn(client, "batch");
    try {
      await expect(
        auditFixtureCardinality(client, SMALL_COUNTS, {
          maxRowsPerStatement: 10,
          statementsPerRequest: 2,
        }),
      ).rejects.toThrow("bounded fixture census requires exactly one statement per request");
      expect(batch).not.toHaveBeenCalled();
      expect(() =>
        boundedFixtureCensusRequestCount(SMALL_COUNTS, { statementsPerRequest: 2 }),
      ).toThrow("bounded fixture census requires exactly one statement per request");
    } finally {
      client.close();
    }
  });

  it("rejects hosted rowid gaps, boundary extras, and compensating rows", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });
      await client.execute("delete from perf_artists where rowid = 1");
      await client.execute(
        `insert into perf_artists (rowid, id, name, renderable_track_count, rankable_track_count)
         values (12, 'synthetic-extra-artist', 'Synthetic Extra', 0, 0)`,
      );
      await client.execute(
        `insert into perf_galaxies (rowid, id, name) values
         (0, 'synthetic-underflow-galaxy', 'Synthetic Underflow'),
         (1, 'synthetic-overflow-galaxy', 'Synthetic Overflow')`,
      );

      const census = await auditFixtureCardinality(client, SMALL_COUNTS, {
        maxRowsPerStatement: 10,
        statementsPerRequest: 1,
      });

      expect(census.passed).toBe(false);
      expect(census.tables.observed.perf_artists).toBe(10);
      expect(census.tables.observed.perf_galaxies).toBe(0);
      expect(census.mismatches).toEqual(
        expect.arrayContaining([
          "table perf_artists rowid 1-10: expected 10, observed 9",
          "table perf_artists rowid boundary overflow: expected 0, observed 1",
          "table perf_galaxies rowid boundary underflow: expected 0, observed 1",
          "table perf_galaxies rowid boundary overflow: expected 0, observed 1",
        ]),
      );
    } finally {
      client.close();
    }
  });

  it("rejects a count-compensated embedding outside the synthetic track-key domain", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });
      await client.execute("delete from perf_track_embeddings where rowid = 1");
      await client.execute(
        `insert into perf_track_embeddings (rowid, track_id, embedding_blob)
         values (1, 'synthetic-track-999999999', zeroblob(4096))`,
      );

      expect(await scalar(client, "select count(*) as n from perf_track_embeddings")).toBe(
        SMALL_COUNTS.trackEmbeddings,
      );
      const census = await auditFixtureCardinality(client, SMALL_COUNTS, {
        maxRowsPerStatement: 10,
        statementsPerRequest: 1,
      });

      expect(census.passed).toBe(false);
      expect(census.tables.observed.perf_track_embeddings).toBe(SMALL_COUNTS.trackEmbeddings - 1);
      expect(census.mismatches).toEqual(
        expect.arrayContaining([
          "table perf_track_embeddings: expected 19, observed 18",
          "distribution trackEmbeddings: expected 19, observed 18",
        ]),
      );
      expect(
        census.mismatches.some((mismatch) =>
          mismatch.startsWith("table perf_track_embeddings rowid boundary"),
        ),
      ).toBe(false);
    } finally {
      client.close();
    }
  });

  it("keeps filtered distribution drift independent from exact table cardinality", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });
      await client.execute(
        "update perf_tracks set label_scope = 'disabled' where rowid = (select min(rowid) from perf_tracks where label_scope = 'enabled')",
      );

      const census = await auditFixtureCardinality(client, SMALL_COUNTS, {
        maxRowsPerStatement: 10,
        statementsPerRequest: 1,
      });

      expect(census.tables.observed.perf_tracks).toBe(SMALL_COUNTS.tracks);
      expect(census.distributions.observed.enabledLabelTracks).toBe(
        SMALL_COUNTS.enabledLabelTracks - 1,
      );
      expect(census.mismatches).toContain(
        "distribution enabledLabelTracks: expected 37, observed 36",
      );
    } finally {
      client.close();
    }
  });

  it("uses bounded rowid seeks for ordinary rows and a covering index for embedding blobs", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      const plan = await client.execute({
        args: [1, HOSTED_FIXTURE_CENSUS_ROW_LIMIT],
        sql: `explain query plan select count(*) as count
          from perf_crawl_due_work not indexed where rowid between ? and ?`,
      });
      const detail = plan.rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .join("\n");

      expect(detail).toMatch(/integer primary key/i);
      expect(detail).not.toMatch(/perf_crawl_due_work_(?:ready|release|scheduled|repair|lease)/i);

      const embeddingPlan = await client.execute({
        args: ["synthetic-track-000000000", "synthetic-track-000049999"],
        sql: `explain query plan select count(*) as count
          from perf_track_embeddings where track_id between ? and ?`,
      });
      const embeddingDetail = embeddingPlan.rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .join("\n");

      expect(embeddingDetail).toMatch(/using covering index/i);
      expect(embeddingDetail).toMatch(/track_id>/i);
      expect(embeddingDetail).not.toMatch(/integer primary key/i);
    } finally {
      client.close();
    }
  });

  it("resets only perf tables so a smaller rerun cannot inherit a larger profile", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    const smaller: FixtureCounts = {
      ...SMALL_COUNTS,
      crawlFrontier: 17,
      enabledLabelTracks: 11,
      findings: 1,
      musicbrainzIsrcBacklog: 5,
      pendingFrontier: 9,
      trackArtists: 20,
      trackEmbeddings: 7,
      tracks: 17,
      youtubeProvenanceBacklog: 4,
    };

    try {
      await client.execute("create table product_sentinel (id integer primary key)");
      await client.execute("insert into product_sentinel (id) values (1)");
      await client.execute(
        `create table ${FIXTURE_IDENTITY_TABLE} (singleton integer primary key)`,
      );
      await applyFixtureSchema(client);
      await writeFixture(client, "4x", { counts: SMALL_COUNTS });
      expect(await scalar(client, "select count(*) as n from perf_tracks")).toBe(41);

      await resetFixture(client);
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: smaller });

      expect(await scalar(client, "select count(*) as n from perf_tracks")).toBe(17);
      expect(await scalar(client, "select count(*) as n from perf_crawl_frontier")).toBe(17);
      expect(await scalar(client, "select count(*) as n from product_sentinel")).toBe(1);
      const identity = await client.execute({
        args: [FIXTURE_IDENTITY_TABLE],
        sql: `select count(*) as n from sqlite_master where type = 'table' and name = ?`,
      });
      expect(Number(identity.rows[0]?.n ?? -1)).toBe(0);
    } finally {
      client.close();
    }
  });
});
