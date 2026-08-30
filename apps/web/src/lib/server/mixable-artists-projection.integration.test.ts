import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillMixableArtistsProjection } from "../../../scripts/backfill-mixable-artists-projection";
import { createIntegrationDb, seedArtist, seedCatalogueTrack } from "./integration-db";
import {
  MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE,
  MIXABLE_ARTISTS_PROJECTION_STATE_KEY,
  mixableArtistsProjectionQuery,
  readMixableArtistsProjection,
} from "./mixable-artists-projection";

let db: Client;

function assertPositionalBindCount(statement: InStatement): void {
  if (typeof statement === "string") {
    return;
  }
  const args = statement.args;
  if (args === undefined || !Array.isArray(args)) {
    return;
  }
  expect(args).toHaveLength(statement.sql.match(/\?/g)?.length ?? 0);
}

function strictBindClient(client: Client): Client {
  return new Proxy(client, {
    get(target, property) {
      if (property === "execute") {
        return (statement: InStatement) => {
          assertPositionalBindCount(statement);
          return target.execute(statement);
        };
      }
      if (property === "batch") {
        return (statements: Array<InStatement>, mode?: "read" | "write" | "deferred") => {
          statements.forEach(assertPositionalBindCount);
          return target.batch(statements, mode);
        };
      }
      const value: unknown = target[property as keyof Client];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedArtist(db, { id: "art-a", name: "Alpha", slug: "alpha" });
  await seedArtist(db, { id: "art-b", name: "Beta", slug: "beta" });
  await seedArtist(db, { id: "art-c", name: "Gamma", slug: "gamma" });
  for (const trackId of ["rank-a-1", "rank-a-2", "rank-b-1", "not-rankable"]) {
    await seedCatalogueTrack(db, { trackId });
  }
  await db.batch(
    [
      `update tracks set key = '8A', has_embedding = 1
       where track_id in ('rank-a-1', 'rank-a-2', 'rank-b-1')`,
      `insert into track_artists (track_id, artist_id, position) values
       ('rank-a-1', 'art-a', 1), ('rank-a-2', 'art-a', 1),
       ('rank-b-1', 'art-b', 1), ('not-rankable', 'art-c', 1)`,
    ],
    "write",
  );
});

afterEach(() => db.close());

describe("mixable artist projection cutover", () => {
  it("falls back to exact source truth until the post-deploy activation pass completes", async () => {
    expect(await readMixableArtistsProjection(db, { limit: 60, q: "" })).toEqual([
      { imageUrl: undefined, name: "Alpha", slug: "alpha", trackCount: 2 },
      { imageUrl: undefined, name: "Beta", slug: "beta", trackCount: 1 },
    ]);

    // Model an old-Worker write in the migration→deploy window. The fallback must still read it.
    await db.execute(
      `update tracks set key = '9A', has_embedding = 1 where track_id = 'not-rankable'`,
    );
    expect(await readMixableArtistsProjection(db, { limit: 60, q: "Gamma" })).toEqual([
      { imageUrl: undefined, name: "Gamma", slug: "gamma", trackCount: 1 },
    ]);

    const activation = await backfillMixableArtistsProjection(strictBindClient(db), {
      activate: true,
    });
    expect(activation).toMatchObject({ artists: 6, pages: 2, passes: 2, skipped: false });
    let state = await db.execute({
      args: [MIXABLE_ARTISTS_PROJECTION_STATE_KEY],
      sql: `select value from settings where key = ?`,
    });
    expect(state.rows[0]?.value).toBe(MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE);
    expect(await readMixableArtistsProjection(db, { limit: 1, q: "" })).toEqual([
      { imageUrl: undefined, name: "Alpha", slug: "alpha", trackCount: 2 },
    ]);

    // Every deploy reconciles from the first artist even from COMPLETE, so a predeploy source
    // repair cannot be hidden behind yesterday's readiness fence.
    await db.execute(`update artists set rankable_track_count = 99 where id = 'art-a'`);
    const repeated = await backfillMixableArtistsProjection(db, { activate: true });
    expect(repeated).toMatchObject({ artists: 6, pages: 2, passes: 2, skipped: false });
    expect(await readMixableArtistsProjection(db, { limit: 1, q: "" })).toEqual([
      { imageUrl: undefined, name: "Alpha", slug: "alpha", trackCount: 2 },
    ]);
  });

  it("drains an in-flight old-Worker write before marking the projection complete", async () => {
    const result = await backfillMixableArtistsProjection(db, {
      activate: true,
      onPassComplete: async (pass) => {
        if (pass === 1) {
          await db.execute(
            `update tracks set key = '9A', has_embedding = 1 where track_id = 'not-rankable'`,
          );
        }
      },
    });
    expect(result.passes).toBe(3);
    expect(await readMixableArtistsProjection(db, { limit: 60, q: "Gamma" })).toEqual([
      { imageUrl: undefined, name: "Gamma", slug: "gamma", trackCount: 1 },
    ]);
  });

  it("uses only the artist-grain ordering index after cutover", async () => {
    await backfillMixableArtistsProjection(db, { activate: true });
    const plan = await db.execute({
      args: [60],
      sql: `explain query plan ${mixableArtistsProjectionQuery("")}`,
    });
    const detail = plan.rows
      .map((row) => (typeof row.detail === "string" ? row.detail : ""))
      .join("\n");
    expect(detail).toContain("artists_mixable_order_idx");
    expect(detail).not.toContain("track_artists");
    expect(detail).not.toContain("SCAN tracks");
    expect(detail).not.toContain("USE TEMP B-TREE");
  });

  it("preserves case-insensitive q semantics and count/name ordering", async () => {
    await backfillMixableArtistsProjection(db, { activate: true });
    expect(await readMixableArtistsProjection(db, { limit: 10, q: "a" })).toEqual([
      { imageUrl: undefined, name: "Alpha", slug: "alpha", trackCount: 2 },
      { imageUrl: undefined, name: "Beta", slug: "beta", trackCount: 1 },
    ]);
  });
});
