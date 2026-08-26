import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";

import {
  FIXTURE_TABLES,
  applyFixtureSchema,
  fixtureFingerprint,
  generateFixture,
  resetFixture,
  writeFixture,
} from "./fixture";
import { type FixtureCounts } from "./manifest";

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
      due_work: SMALL_COUNTS.tracks,
      perf_albums: SMALL_COUNTS.albums,
      perf_artists: SMALL_COUNTS.artists,
      perf_crawl_frontier: SMALL_COUNTS.crawlFrontier,
      perf_findings: SMALL_COUNTS.findings,
      perf_labels: SMALL_COUNTS.labels,
      perf_track_artists: SMALL_COUNTS.trackArtists,
      perf_track_embeddings: SMALL_COUNTS.trackEmbeddings,
      perf_tracks: SMALL_COUNTS.tracks,
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

  it("materializes exact fan-out, null, selectivity, and backlog counts locally", async () => {
    const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    try {
      await applyFixtureSchema(client);
      await writeFixture(client, "1x", { counts: SMALL_COUNTS });

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
      expect(await scalar(client, "select count(*) as n from due_work where state = 'ready'")).toBe(
        41,
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
