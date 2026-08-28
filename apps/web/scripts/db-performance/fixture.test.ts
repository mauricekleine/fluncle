import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

import {
  FIXTURE_TABLES,
  applyFixtureSchema,
  auditFixtureCardinality,
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
      await applyFixtureSchema(client);
      await writeFixture(client, "4x", { counts: SMALL_COUNTS });
      expect(await scalar(client, "select count(*) as n from perf_tracks")).toBe(41);

      await resetFixture(client);
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: smaller });

      expect(await scalar(client, "select count(*) as n from perf_tracks")).toBe(17);
      expect(await scalar(client, "select count(*) as n from perf_crawl_frontier")).toBe(17);
      expect(await scalar(client, "select count(*) as n from product_sentinel")).toBe(1);
    } finally {
      client.close();
    }
  });
});
