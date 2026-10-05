import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: async () => holder.db };
});

import { publicTrackWhere } from "../../db/public-track-visibility";
import { LONG_FORM_MS } from "../catalogue-eligibility";
import { releasedByTodaySql } from "./release-day";
import { createIntegrationDb } from "./integration-db";
import { readKeyHistogram } from "./key-histogram";
import {
  PUBLIC_AGGREGATE_DURATION_GENERATION_KEY,
  PUBLIC_AGGREGATE_VISIBILITY_VERSION_KEY,
  PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  readProjectedAggregateBuckets,
  readProjectedDefaultTrackTotal,
  readProjectedTrackHubPageStart,
} from "./public-projection-cutover";
import { markPublicTrackSourceChangedStatements } from "./public-projection-source-maintenance";
import {
  MAX_PUBLIC_PROJECTION_CHUNK_SIZE,
  rebuildDefaultTrackHubAnchors,
  rebuildPublicProjection,
  repairPublicProjectionChunk,
} from "./public-projections";
import {
  countAllTracks,
  listTracksHubYearLane,
  readDefaultTracksHubTotal,
  resetTracksHubAggregateCache,
  TRACKS_HUB_ANCHOR_ADDRESS,
  TRACKS_HUB_PAGE_SIZE,
  tracksHubCountQuery,
} from "./tracks-hub";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const TODAY = "2026-10-05";
let db: Client;

async function insertTrack(
  id: string,
  options: {
    duration?: number;
    finding?: boolean;
    key?: null | string;
    releaseDate?: null | string;
    title?: string;
  } = {},
): Promise<void> {
  await mutate(id, [
    {
      args: [
        id,
        options.title ?? "Night Flight",
        options.duration ?? 270000,
        options.releaseDate === undefined ? "2024-01-01" : options.releaseDate,
        options.key === undefined ? "Am" : options.key,
      ],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, release_date, key)
        values (?, ?, '["Artist"]', ?, ?, ?)`,
    },
    ...(options.finding
      ? [
          {
            args: [id, NOW.toISOString()],
            sql: `insert into findings (track_id, added_at) values (?, ?)`,
          },
        ]
      : []),
  ]);
}

async function mutate(id: string, statements: InStatement[]): Promise<void> {
  await db.batch(
    [...statements, ...markPublicTrackSourceChangedStatements(id, "source-write", { now: NOW })],
    "write",
  );
}

async function liveTotal(today?: string): Promise<number> {
  const result = await db.execute(tracksHubCountQuery({}, {}, today));
  return Number(result.rows[0]?.total);
}

async function liveBuckets(kind: "key" | "release_date_bucket", today?: string) {
  const bucket = kind === "key" ? "t.key" : "substr(t.release_date, 1, 4)";
  const result = await db.execute({
    args: today === undefined ? [] : [today],
    sql: `select ${bucket} as bucket, count(*) as track_count from tracks t
      where ${publicTrackWhere("t")} and ${bucket} is not null
        ${today === undefined ? "" : `and ${releasedByTodaySql("t.release_date")}`}
      group by ${bucket} order by bucket ${kind === "key" ? "asc" : "desc"}`,
  });
  return result.rows.map((row) => ({ bucket: row.bucket, count: Number(row.track_count) }));
}

async function expectExactProjection(): Promise<void> {
  expect(await readProjectedDefaultTrackTotal(db)).toBe(await liveTotal());
  for (const kind of ["release_date_bucket", "key"] as const) {
    expect(await readProjectedAggregateBuckets(db, kind)).toEqual(await liveBuckets(kind));
  }
  expect(await readProjectedAggregateBuckets(db, "release_date_bucket", TODAY)).toEqual(
    await liveBuckets("release_date_bucket", TODAY),
  );
}

async function expectUnavailable(): Promise<void> {
  expect(await readProjectedDefaultTrackTotal(db)).toBeUndefined();
  expect(await readProjectedAggregateBuckets(db, "key")).toBeUndefined();
  expect(await readProjectedAggregateBuckets(db, "release_date_bucket", TODAY)).toBeUndefined();
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  resetTracksHubAggregateCache();
  await insertTrack("retitle", { key: "Bm", releaseDate: "2021-01-01" });
  await insertTrack("delete", { key: "Cm", releaseDate: "2022-01-01" });
  await insertTrack("move", { key: "Dm", releaseDate: "2023-01-01" });
  await insertTrack("null-buckets", { key: null, releaseDate: null });
  await rebuildPublicProjection(db, "public_aggregates", {
    generation: "exact-aggregate",
    limit: 100,
  });
  await repairPublicProjectionChunk(db, {
    limit: 100,
    now: () => NOW,
    projection: "public_aggregates",
  });
  await rebuildDefaultTrackHubAnchors(db, { generation: "exact-aggregate", now: () => NOW });
  await db.execute({
    args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY, "true"],
    sql: `insert into settings (key, value) values (?, ?)`,
  });
});

afterEach(() => db.close());

describe("exact projected aggregates under bounded repair debt", () => {
  it("matches live visibility and buckets through source writes and repair batches", async () => {
    await expectExactProjection();
    expect(
      await readProjectedTrackHubPageStart(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE, 1),
    ).toMatchObject({ total: 4 });
    await insertTrack("malformed-release", { key: "Am", releaseDate: "20x?long" });
    await expectExactProjection();
    await mutate("malformed-release", [
      { sql: `delete from tracks where track_id = 'malformed-release'` },
    ]);
    await expectExactProjection();
    await insertTrack("public", { key: "Em", releaseDate: "2025-01-01" });
    await expectExactProjection();
    await insertTrack("long-catalogue", { duration: LONG_FORM_MS });
    await expectExactProjection();
    await insertTrack("spoken-catalogue", { title: "Artist - Interview" });
    await expectExactProjection();
    await mutate("retitle", [
      { sql: `update tracks set title = 'Artist - Interview' where track_id = 'retitle'` },
    ]);
    await expectExactProjection();
    await mutate("delete", [{ sql: `delete from tracks where track_id = 'delete'` }]);
    await expectExactProjection();
    await insertTrack("long-finding", {
      duration: LONG_FORM_MS,
      finding: true,
      key: "Fm",
      releaseDate: "2020-01-01",
      title: "Artist - Interview",
    });
    await expectExactProjection();
    await mutate("move", [
      { sql: `update tracks set release_date = '2026-11-01', key = 'Gm' where track_id = 'move'` },
    ]);
    await expectExactProjection();
    await mutate("null-buckets", [
      {
        sql: `update tracks set release_date = '2019-01-01', key = 'Abm' where track_id = 'null-buckets'`,
      },
    ]);
    await expectExactProjection();
    await mutate("public", [
      { sql: `update tracks set release_date = null, key = null where track_id = 'public'` },
    ]);
    await expectExactProjection();

    expect(await liveTotal()).toBe(4);
    expect(await liveTotal(TODAY)).toBe(3);
    const fullCounts = [tracksHubCountQuery({}).sql, tracksHubCountQuery({}, {}, TODAY).sql];
    const statements: string[] = [];
    const traced = {
      ...db,
      execute: async (statement: InStatement) => {
        statements.push(typeof statement === "string" ? statement : statement.sql);
        return db.execute(statement);
      },
    } as Client;
    holder.db = traced;
    expect(await countAllTracks(NOW)).toBe(3);
    expect(await readDefaultTracksHubTotal(traced)).toBe(4);
    expect(await listTracksHubYearLane({}, NOW)).toEqual([
      { page: 1, year: "2020" },
      { page: 1, year: "2019" },
    ]);
    expect(await readKeyHistogram()).toEqual([
      { count: 1, key: "Abm" },
      { count: 1, key: "Fm" },
      { count: 1, key: "Gm" },
    ]);
    expect(statements.filter((sql) => fullCounts.includes(sql))).toEqual([]);
    expect(
      await readProjectedTrackHubPageStart(db, TRACKS_HUB_ANCHOR_ADDRESS, TRACKS_HUB_PAGE_SIZE, 1),
    ).toBeUndefined();

    for (let pass = 0; pass < 10; pass += 1) {
      await repairPublicProjectionChunk(db, {
        limit: 2,
        now: () => NOW,
        projection: "public_aggregates",
      });
      await expectExactProjection();
    }
    expect(
      (
        await db.execute(
          `select subject_id from projection_repairs where projection = 'public_aggregates'`,
        )
      ).rows,
    ).toEqual([]);
  });

  it.each([
    { key: "Am", label: "populated", releaseDate: "2024-01-01" },
    { key: null, label: "null", releaseDate: null },
  ])("accepts one repair page and rejects larger debt with $label buckets", async (buckets) => {
    if (buckets.key === null) {
      for (const id of ["retitle", "delete", "move"]) {
        await mutate(id, [
          {
            args: [id],
            sql: `update tracks set key = null, release_date = null where track_id = ?`,
          },
        ]);
      }
      await repairPublicProjectionChunk(db, {
        limit: 100,
        now: () => NOW,
        projection: "public_aggregates",
      });
      expect((await db.execute(`select bucket from public_aggregate_counts`)).rows).toEqual([]);
    }
    for (let index = 0; index < MAX_PUBLIC_PROJECTION_CHUNK_SIZE; index += 1) {
      await insertTrack(`debt-${index}`, buckets);
    }
    await expectExactProjection();
    await insertTrack("overflow", buckets);
    await expectUnavailable();
    expect(await readDefaultTracksHubTotal(db)).toBe(await liveTotal());
  });

  it("returns empty buckets when bounded debt removes all bucketed members", async () => {
    for (const id of ["retitle", "delete", "move"]) {
      await mutate(id, [{ args: [id], sql: `delete from tracks where track_id = ?` }]);
    }
    await expectExactProjection();
    expect(await readProjectedAggregateBuckets(db, "key")).toEqual([]);
    expect(await readProjectedAggregateBuckets(db, "release_date_bucket", TODAY)).toEqual([]);
  });

  it.each([null, "", "malformed", -1, 0.5])(
    "rejects malformed projected counts: %s",
    async (value) => {
      const malformed = {
        execute: async (statement: InStatement) => {
          const result = await db.execute(statement);
          return {
            ...result,
            rows: result.rows.map((row) => {
              if ("total" in row) {
                return { ...row, total: value };
              }
              if ("track_count" in row) {
                return { ...row, track_count: value };
              }
              return row;
            }),
          };
        },
      };
      expect(await readProjectedDefaultTrackTotal(malformed)).toBeUndefined();
      expect(await readProjectedAggregateBuckets(malformed, "key")).toBeUndefined();
    },
  );

  it.each([
    [
      "an epoch mismatch without markers",
      `update public_aggregate_state set source_epoch = aggregate_epoch + 1`,
    ],
    [
      "an incomplete projection",
      `update public_aggregate_state set state = 'running', completed_at = null`,
    ],
    [
      "a stale visibility marker",
      `update settings set value = 'stale' where key = '${PUBLIC_AGGREGATE_VISIBILITY_VERSION_KEY}'`,
    ],
    [
      "a stale duration marker",
      `update settings set value = 'stale' where key = '${PUBLIC_AGGREGATE_DURATION_GENERATION_KEY}'`,
    ],
    [
      "disabled cutover",
      `update settings set value = 'false' where key = '${PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY}'`,
    ],
  ])("uses live reads with %s", async (_name, sql) => {
    await db.execute(sql);
    await expectUnavailable();
  });

  it.each(["total", "key", "release_date_bucket"] as const)(
    "%s seeks repair subjects and their primary keys instead of scanning tracks",
    async (kind) => {
      await insertTrack("pending");
      let captured: InStatement | undefined;
      const traced = {
        execute: async (statement: InStatement) => {
          captured = statement;
          return db.execute(statement);
        },
      };
      if (kind === "total") {
        await readProjectedDefaultTrackTotal(traced);
      } else {
        await readProjectedAggregateBuckets(traced, kind, TODAY);
      }
      if (captured === undefined) {
        throw new Error("projected aggregate statement was not issued");
      }
      const sql = typeof captured === "string" ? captured : captured.sql;
      const args = typeof captured === "string" ? [] : captured.args;
      const plan = await db.execute({ args, sql: `explain query plan ${sql}` });
      const details = plan.rows.flatMap((row) =>
        typeof row.detail === "string" ? [row.detail] : [],
      );
      expect(details.some((detail) => /^SCAN (?:tracks|t)\b/.test(detail))).toBe(false);
      expect(details.some((detail) => /^SEARCH t\b.*\(track_id=\?\)/.test(detail))).toBe(true);
      expect(details.some((detail) => /^SEARCH membership\b.*\(track_id=\?\)/.test(detail))).toBe(
        true,
      );
      expect(
        details.filter((detail) =>
          /^SEARCH projection_repairs\b.*projection_repairs_order_idx/.test(detail),
        ),
      ).toHaveLength(1);
    },
  );
});
