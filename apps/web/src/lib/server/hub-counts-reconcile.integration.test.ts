import { type Client, type InStatement } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationDb,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedTrack,
} from "./integration-db";
import { DUE_WORK_SOURCE_REPAIR_KIND, MAX_DUE_WORK_CHUNK_SIZE } from "./due-work";
import { hubCountDeltaStatement } from "./hub-counts";

let db: Client;

let wrapped: Client | undefined;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(wrapped ?? db) };
});

const { HUB_COUNTS_RECONCILE_PAGE_SIZE, reconcileHubCounts } =
  await import("./hub-counts-reconcile");

type Counts = { certified: number; renderable: number };

async function counts(table: "albums" | "artists" | "labels", id: string): Promise<Counts> {
  const result = await db.execute({
    args: [id],
    sql: `select renderable_track_count as renderable, certified_finding_count as certified
          from ${table} where id = ?`,
  });
  const row = result.rows[0];

  return { certified: Number(row?.certified ?? -1), renderable: Number(row?.renderable ?? -1) };
}

async function setCounts(
  table: "albums" | "artists" | "labels",
  id: string,
  value: Counts,
): Promise<void> {
  await db.execute({
    args: [value.renderable, value.certified, id],
    sql: `update ${table}
            set renderable_track_count = ?, certified_finding_count = ?
          where id = ?`,
  });
}

beforeEach(async () => {
  wrapped = undefined;
  db = await createIntegrationDb();
  await seedLabel(db, { id: "lab-1", name: "Hospital Records", slug: "hospital-records" });
  await seedAlbum(db, { id: "alb-1", name: "Sight To Behold", slug: "sight-to-behold" });
  await seedArtist(db, { id: "art-1", name: "Logistics", slug: "logistics" });
  await seedTrack(db, { logId: "004.7.2A", trackId: "t-cert-0000000000000a" });
  await seedTrack(db, { logId: "004.7.2B", trackId: "t-cert-0000000000000b" });
  await seedCatalogueTrack(db, { trackId: "t-cat-00000000000000a" });

  await db.batch(
    [
      `update tracks set label_id = 'lab-1', album_id = 'alb-1'`,
      `insert into track_artists (track_id, artist_id, position)
       values ('t-cert-0000000000000a', 'art-1', 1),
              ('t-cert-0000000000000b', 'art-1', 1),
              ('t-cat-00000000000000a', 'art-1', 1)`,
      `update tracks set key = '8A', has_embedding = 1
       where track_id = 't-cert-0000000000000a'`,
    ],
    "write",
  );
});

describe("reconcileHubCounts — the grouped correction", () => {
  it("repairs the artist-grain rankable-track projection", async () => {
    await reconcileHubCounts();
    let row = await db.execute(`select rankable_track_count as n from artists where id = 'art-1'`);
    expect(Number(row.rows[0]?.n ?? -1)).toBe(1);

    await db.execute(`update artists set rankable_track_count = 9 where id = 'art-1'`);
    const result = await reconcileHubCounts();
    row = await db.execute(`select rankable_track_count as n from artists where id = 'art-1'`);
    expect(result.artists).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(Number(row.rows[0]?.n ?? -1)).toBe(1);
  });
  it("corrects a drifted counter on all three tables and reports one row each", async () => {
    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(result.albums).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(result.artists).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 2, renderable: 3 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
    const repairs = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND],
      sql: `select subject_type, subject_id from due_work
            where work_kind = ? order by subject_type, subject_id`,
    });
    expect(repairs.rows).toEqual([
      { subject_id: "alb-1", subject_type: "album" },
      { subject_id: "art-1", subject_type: "artist" },
      { subject_id: "lab-1", subject_type: "label" },
    ]);
  });

  it("corrects an OVER-count too, not only an under-count", async () => {
    await setCounts("labels", "lab-1", { certified: 9, renderable: 12 });

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("corrects a HALF-drifted pair (renderable right, certified wrong)", async () => {
    await setCounts("albums", "alb-1", { certified: 3, renderable: 3 });

    const result = await reconcileHubCounts();

    expect(result.albums).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("reports ZERO corrected on an already-correct archive — the healthy steady state", async () => {
    await reconcileHubCounts();
    const second = await reconcileHubCounts();

    expect(second.labels).toEqual({ corrected: 0, deferred: 0, latestCorrected: 0 });
    expect(second.albums).toEqual({ corrected: 0, deferred: 0, latestCorrected: 0 });
    expect(second.artists).toEqual({ corrected: 0, deferred: 0, latestCorrected: 0 });
  });

  it("is idempotent — a third pass still writes nothing and reports nothing", async () => {
    await reconcileHubCounts();
    await reconcileHubCounts();
    const third = await reconcileHubCounts();

    expect(third).toMatchObject({
      albums: { corrected: 0 },
      artists: { corrected: 0 },
      labels: { corrected: 0 },
    });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 3 });
  });

  it("reports a tookMs", async () => {
    const result = await reconcileHubCounts();

    expect(result.tookMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.tookMs)).toBe(true);
  });
});

describe("reconcileHubCounts — the zero-truth pass", () => {
  it("zeroes a label whose last track was deleted out of band", async () => {
    await reconcileHubCounts();

    await db.execute(`delete from tracks`);
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 3 });

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 0, renderable: 0 });
  });

  it("zeroes an emptied album and artist in the same pass", async () => {
    await reconcileHubCounts();
    await db.execute(`delete from tracks`);

    const result = await reconcileHubCounts();

    expect(result.albums).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(result.artists).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("albums", "alb-1")).toEqual({ certified: 0, renderable: 0 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 0, renderable: 0 });
  });

  it("leaves an already-zero unlinked entity alone — it is not 'corrected'", async () => {
    await seedLabel(db, { id: "lab-empty", name: "Nothing Here", slug: "nothing-here" });

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("labels", "lab-empty")).toEqual({ certified: 0, renderable: 0 });
  });

  it("still zeroes when NO track carries the pointer at all (the NOT IN null trap)", async () => {
    await reconcileHubCounts();
    await db.execute(`update tracks set label_id = null`);

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 0, renderable: 0 });
  });
});

describe("reconcileHubCounts — the pinned artists source (orphaned edges)", () => {
  it("does NOT count a track_artists edge whose track is gone", async () => {
    await reconcileHubCounts();

    await db.execute(`delete from tracks where track_id = 't-cat-00000000000000a'`);

    const result = await reconcileHubCounts();

    expect(result.artists).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 2, renderable: 2 });
  });

  it("zeroes an artist left holding ONLY orphaned edges", async () => {
    await reconcileHubCounts();
    await db.execute(`delete from tracks`);

    const result = await reconcileHubCounts();

    const edges = await db.execute(`select count(*) as n from track_artists`);
    expect(Number(edges.rows[0]?.n ?? 0)).toBe(3);
    expect(result.artists).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("artists", "art-1")).toEqual({ certified: 0, renderable: 0 });
  });
});

type HubTable = "albums" | "artists" | "labels";
const HUB_TABLES: readonly HubTable[] = ["labels", "albums", "artists"];

const ORACLE_SOURCES: Record<HubTable, string> = {
  albums: `select album_id as entity_id, count(*) as renderable,
                  sum(case when is_catalogue = 0 then 1 else 0 end) as certified, 0 as rankable
           from tracks where album_id is not null group by album_id`,
  artists: `select ta.artist_id as entity_id, count(*) as renderable,
                   sum(case when t.is_catalogue = 0 then 1 else 0 end) as certified,
                   sum(case when t.key is not null and t.has_embedding = 1 then 1 else 0 end) as rankable
            from track_artists ta join tracks t on t.track_id = ta.track_id group by ta.artist_id`,
  labels: `select label_id as entity_id, count(*) as renderable,
                  sum(case when is_catalogue = 0 then 1 else 0 end) as certified, 0 as rankable
           from tracks where label_id is not null group by label_id`,
};

async function oracleReconcile(client: Client): Promise<Record<HubTable, number>> {
  const corrected: Record<HubTable, number> = { albums: 0, artists: 0, labels: 0 };

  for (const table of HUB_TABLES) {
    const rankable = table === "artists";
    const source = ORACLE_SOURCES[table];
    const grouped = await client.execute(
      `update ${table}
       set renderable_track_count = src.renderable, certified_finding_count = src.certified
           ${rankable ? ", rankable_track_count = src.rankable" : ""}
       from (${source}) src
       where ${table}.id = src.entity_id
         and (${table}.renderable_track_count <> src.renderable
              or ${table}.certified_finding_count <> src.certified
              ${rankable ? "or artists.rankable_track_count <> src.rankable" : ""})`,
    );
    const zeroed = await client.execute(
      `update ${table}
       set renderable_track_count = 0, certified_finding_count = 0
           ${rankable ? ", rankable_track_count = 0" : ""}
       where (renderable_track_count <> 0 or certified_finding_count <> 0
              ${rankable ? "or rankable_track_count <> 0" : ""})
         and id not in (select entity_id from (${source}))`,
    );
    corrected[table] = grouped.rowsAffected + zeroed.rowsAffected;
  }

  return corrected;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const ENTITY_COUNT = 23;

function entityId(table: HubTable, index: number): string {
  return `${table.slice(0, 3)}-${String(index).padStart(2, "0")}`;
}

async function seedDriftedArchive(client: Client, seed: number): Promise<void> {
  const random = mulberry32(seed);
  const pick = (table: HubTable) => entityId(table, 2 + Math.floor(random() * (ENTITY_COUNT - 2)));

  for (let index = 0; index < ENTITY_COUNT; index += 1) {
    await seedLabel(client, { id: entityId("labels", index), slug: `label-${index}` });
    await seedAlbum(client, { id: entityId("albums", index), slug: `album-${index}` });
    await seedArtist(client, { id: entityId("artists", index), slug: `artist-${index}` });
  }

  const trackCount = 90;
  const doomed: string[] = [];
  const statements: InStatement[] = [];

  for (let index = 0; index < trackCount; index += 1) {
    const trackId = `t-${String(index).padStart(20, "0")}`;
    const isDoomed = index % 11 === 0;
    await seedCatalogueTrack(client, { trackId });

    const pointer = (table: HubTable): null | string => {
      if (isDoomed && index % 2 === 0) {
        return entityId(table, 1);
      }
      const roll = random();
      if (roll < 0.15) {
        return null;
      }
      if (roll < 0.2) {
        return `${table.slice(0, 3)}-dangling`;
      }
      return pick(table);
    };

    statements.push({
      args: [
        pointer("labels"),
        pointer("albums"),
        random() < 0.4 ? 0 : 1,
        random() < 0.6 ? "8A" : null,
        random() < 0.5 ? 1 : 0,
        trackId,
      ],
      sql: `update tracks
            set label_id = ?, album_id = ?, is_catalogue = ?, key = ?, has_embedding = ?
            where track_id = ?`,
    });

    const artists = new Set<string>();
    if (isDoomed) {
      artists.add(entityId("artists", 1));
    }
    const edgeCount = Math.floor(random() * 4);
    for (let edge = 0; edge < edgeCount; edge += 1) {
      artists.add(pick("artists"));
    }
    [...artists].forEach((artistId, position) => {
      statements.push({
        args: [trackId, artistId, position + 1],
        sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, ?)`,
      });
    });

    if (isDoomed) {
      doomed.push(trackId);
    }
  }

  for (const table of HUB_TABLES) {
    for (let index = 0; index < ENTITY_COUNT; index += 1) {
      const stale = index < 2;
      const draw = () => (stale ? 1 + Math.floor(random() * 5) : Math.floor(random() * 6));
      statements.push({
        args:
          table === "artists"
            ? [draw(), draw(), draw(), entityId(table, index)]
            : [draw(), draw(), entityId(table, index)],
        sql:
          table === "artists"
            ? `update artists set renderable_track_count = ?, certified_finding_count = ?,
                 rankable_track_count = ? where id = ?`
            : `update ${table} set renderable_track_count = ?, certified_finding_count = ?
               where id = ?`,
      });
    }
  }

  statements.push({
    args: doomed,
    sql: `delete from tracks where track_id in (${doomed.map(() => "?").join(", ")})`,
  });
  await client.batch(statements, "write");
}

async function counterSnapshot(client: Client): Promise<Record<HubTable, unknown[]>> {
  const snapshot = {} as Record<HubTable, unknown[]>;

  for (const table of HUB_TABLES) {
    const result = await client.execute(
      `select id, renderable_track_count, certified_finding_count
              ${table === "artists" ? ", rankable_track_count" : ""}
       from ${table} order by id`,
    );
    snapshot[table] = result.rows.map((row) => ({ ...row }));
  }

  return snapshot;
}

function recordingClient(
  target: Client,
  onBatch?: (statements: InStatement[]) => Promise<void>,
): {
  batches: Array<{ mode: string | undefined; statements: InStatement[] }>;
  client: Client;
  executes: InStatement[];
} {
  const batches: Array<{ mode: string | undefined; statements: InStatement[] }> = [];
  const executes: InStatement[] = [];

  const client = {
    batch: async (statements: InStatement[], mode?: "deferred" | "read" | "write") => {
      batches.push({ mode, statements });
      await onBatch?.(statements);
      return target.batch(statements, mode);
    },
    execute: async (statement: InStatement) => {
      executes.push(statement);
      return target.execute(statement);
    },
  } as unknown as Client;

  return { batches, client, executes };
}

function sqlOf(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

function argsOf(statement: InStatement): unknown[] {
  if (typeof statement === "string" || statement.args === undefined) {
    return [];
  }
  return Array.isArray(statement.args) ? statement.args : Object.values(statement.args);
}

describe("reconcileHubCounts — parity with the whole-graph correction", () => {
  it.each([1, 7, ENTITY_COUNT, HUB_COUNTS_RECONCILE_PAGE_SIZE])(
    "ends on identical counters and corrections at page size %i",
    async (pageSize) => {
      const oracleDb = await createIntegrationDb();
      await seedDriftedArchive(oracleDb, 7);
      db = await createIntegrationDb();
      await seedDriftedArchive(db, 7);
      expect(await counterSnapshot(db)).toEqual(await counterSnapshot(oracleDb));

      const expected = await oracleReconcile(oracleDb);
      const result = await reconcileHubCounts({ pageSize });

      expect(expected.labels).toBeGreaterThan(0);
      expect(expected.albums).toBeGreaterThan(0);
      expect(expected.artists).toBeGreaterThan(0);
      expect(result.labels).toEqual({
        corrected: expected.labels,
        deferred: 0,
        latestCorrected: 0,
      });
      expect(result.albums).toEqual({
        corrected: expected.albums,
        deferred: 0,
        latestCorrected: 0,
      });
      expect(result.artists).toEqual({
        corrected: expected.artists,
        deferred: 0,
        latestCorrected: 0,
      });
      expect(result.next).toBeNull();
      expect(await counterSnapshot(db)).toEqual(await counterSnapshot(oracleDb));
    },
  );

  it("zeroes the stale entities and ignores orphaned edges exactly as the oracle does", async () => {
    db = await createIntegrationDb();
    await seedDriftedArchive(db, 11);

    await reconcileHubCounts({ pageSize: 5 });

    for (const table of HUB_TABLES) {
      expect(await counts(table, entityId(table, 0))).toEqual({ certified: 0, renderable: 0 });
      expect(await counts(table, entityId(table, 1))).toEqual({ certified: 0, renderable: 0 });
    }
    const edges = await db.execute({
      args: [entityId("artists", 1)],
      sql: `select count(*) as n from track_artists where artist_id = ?`,
    });
    expect(Number(edges.rows[0]?.n ?? 0)).toBeGreaterThan(0);
  });
});

describe("reconcileHubCounts — bounded windows", () => {
  it("chains windows through `next` to the same end state as one full pass", async () => {
    const oracleDb = await createIntegrationDb();
    await seedDriftedArchive(oracleDb, 23);
    db = await createIntegrationDb();
    await seedDriftedArchive(db, 23);
    const expected = await oracleReconcile(oracleDb);

    const totals: Record<HubTable, number> = { albums: 0, artists: 0, labels: 0 };
    let cursor: Awaited<ReturnType<typeof reconcileHubCounts>>["next"] | undefined;
    let windows = 0;

    do {
      const result = await reconcileHubCounts({
        cursor: cursor ?? undefined,
        pageLimit: 2,
        pageSize: 4,
      });
      expect(result.pages).toBeLessThanOrEqual(2);
      for (const table of HUB_TABLES) {
        totals[table] += result[table].corrected;
      }
      cursor = result.next;
      windows += 1;
    } while (cursor !== null && windows < 100);

    expect(cursor).toBeNull();
    expect(windows).toBeGreaterThan(3);
    expect(totals).toEqual(expected);
    expect(await counterSnapshot(db)).toEqual(await counterSnapshot(oracleDb));
  });

  it("resumes a named cursor inside a table and hands the next table its first page", async () => {
    await seedLabel(db, { id: "lab-2", name: "Second", slug: "second" });
    await seedLabel(db, { id: "lab-3", name: "Third", slug: "third" });

    const first = await reconcileHubCounts({ pageLimit: 1, pageSize: 2 });
    expect(first.next).toEqual({ afterId: "lab-2", table: "labels" });
    expect(first.pages).toBe(1);

    const second = await reconcileHubCounts({
      cursor: first.next ?? undefined,
      pageLimit: 1,
      pageSize: 2,
    });
    expect(second.next).toEqual({ afterId: null, table: "albums" });
  });
});

describe("reconcileHubCounts — bounded statement shape", () => {
  it("pins one due-work chunk per page of corrections", () => {
    expect(HUB_COUNTS_RECONCILE_PAGE_SIZE).toBe(250);
    expect(2 * HUB_COUNTS_RECONCILE_PAGE_SIZE).toBe(MAX_DUE_WORK_CHUNK_SIZE);
  });

  it("reads keyset pages and writes only guarded point writes, never an aggregate", async () => {
    db = await createIntegrationDb();
    await seedDriftedArchive(db, 5);
    const pageSize = 6;
    const recorder = recordingClient(db);
    wrapped = recorder.client;

    await reconcileHubCounts({ pageSize });

    expect(recorder.executes.length).toBeGreaterThan(3 * Math.floor(ENTITY_COUNT / pageSize));
    for (const statement of recorder.executes) {
      const sql = sqlOf(statement).toLowerCase();
      expect(sql).toMatch(/^\s*with page as \(/);
      expect(sql).not.toMatch(/\b(insert|update|delete)\b/);
      expect(sql).toMatch(/where id > \?\s+order by id\s+limit \?/);
      expect(argsOf(statement)[1]).toBe(pageSize);
    }

    expect(recorder.batches.length).toBeGreaterThan(0);
    for (const batch of recorder.batches) {
      expect(batch.mode).toBe("write");
      expect(batch.statements.length).toBeLessThanOrEqual(2 * pageSize);
      for (const statement of batch.statements) {
        const sql = sqlOf(statement).toLowerCase().replace(/\s+/g, " ");
        expect(sql).not.toMatch(/\btracks\b|\btrack_artists\b|group by/);
        expect(
          /^update (labels|albums|artists) set .* where id = \? and renderable_track_count = \? and certified_finding_count = \?/.test(
            sql.trim(),
          ) || sql.includes("insert into due_work"),
        ).toBe(true);
      }
    }
  });

  it("issues no write batch at all on an already-correct archive", async () => {
    await reconcileHubCounts();
    const recorder = recordingClient(db);
    wrapped = recorder.client;

    const result = await reconcileHubCounts();

    expect(recorder.batches).toEqual([]);
    expect(result).toMatchObject({
      albums: { corrected: 0, deferred: 0, latestCorrected: 0 },
      artists: { corrected: 0, deferred: 0, latestCorrected: 0 },
      labels: { corrected: 0, deferred: 0, latestCorrected: 0 },
    });
  });
});

describe("reconcileHubCounts — a maintained delta between read and write", () => {
  let lateTracks = 0;

  async function linkLateTrack(): Promise<void> {
    lateTracks += 1;
    const trackId = `t-late-${String(lateTracks).padStart(15, "0")}`;
    await seedCatalogueTrack(db, { trackId });
    await db.batch(
      [
        { args: [trackId], sql: `update tracks set label_id = 'lab-1' where track_id = ?` },
        hubCountDeltaStatement("labels", "lab-1", { certified: 0, renderable: 1 }),
      ],
      "write",
    );
  }

  it("keeps the delta, re-reads the page, and converges on truth", async () => {
    await setCounts("labels", "lab-1", { certified: 9, renderable: 12 });
    let raced = false;
    wrapped = recordingClient(db, async () => {
      if (!raced) {
        raced = true;
        await linkLateTrack();
      }
    }).client;

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 4 });
  });

  it("defers a row that loses twice without overwriting the moved counters or marking it", async () => {
    await setCounts("labels", "lab-1", { certified: 9, renderable: 12 });
    let labelBatches = 0;
    wrapped = recordingClient(db, async (statements) => {
      if (
        labelBatches < 2 &&
        statements.some((statement) => /update labels/.test(sqlOf(statement)))
      ) {
        labelBatches += 1;
        await linkLateTrack();
      }
    }).client;

    const result = await reconcileHubCounts();

    expect(result.labels).toEqual({ corrected: 0, deferred: 1, latestCorrected: 0 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 9, renderable: 14 });
    const markers = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND],
      sql: `select count(*) as n from due_work
            where work_kind = ? and subject_type = 'label' and subject_id = 'lab-1'`,
    });
    expect(Number(markers.rows[0]?.n ?? -1)).toBe(0);

    wrapped = undefined;
    const next = await reconcileHubCounts();
    expect(next.labels).toEqual({ corrected: 1, deferred: 0, latestCorrected: 0 });
    expect(await counts("labels", "lab-1")).toEqual({ certified: 2, renderable: 5 });
  });
});

describe("latest released date reconciliation", () => {
  it("fills only differing dates, ignores future and malformed dates, and clears deleted truth", async () => {
    await db.batch(
      [
        "update tracks set release_date = '2026-01-15' where track_id = 't-cert-0000000000000a'",
        "update tracks set release_date = '2999-01-01' where track_id = 't-cert-0000000000000b'",
        "update tracks set release_date = 'bad-date' where track_id = 't-cat-00000000000000a'",
      ],
      "write",
    );
    const first = await reconcileHubCounts();
    for (const table of ["labels", "albums", "artists"] as const) {
      expect(first[table].latestCorrected).toBe(1);
      const stored = await db.execute(
        `select latest_release_date from ${table} where id = '${table === "labels" ? "lab-1" : table === "albums" ? "alb-1" : "art-1"}'`,
      );
      expect(stored.rows[0]?.latest_release_date).toBe("2026-01-15");
    }
    const second = await reconcileHubCounts();
    expect(second.labels.latestCorrected).toBe(0);
    expect(second.albums.latestCorrected).toBe(0);
    expect(second.artists.latestCorrected).toBe(0);
    await db.execute("delete from tracks where track_id = 't-cert-0000000000000a'");
    const third = await reconcileHubCounts();
    expect(third.labels.latestCorrected).toBe(1);
    expect(third.albums.latestCorrected).toBe(1);
    expect(third.artists.latestCorrected).toBe(1);
  });

  it("counts neither a dismissed nor a duplicate release as the latest one", async () => {
    await db.batch(
      [
        "update tracks set release_date = '2026-01-15' where track_id = 't-cert-0000000000000a'",
        "update tracks set release_date = '2026-03-01', dismissed_at = '2026-03-02' where track_id = 't-cat-00000000000000a'",
        "update tracks set release_date = '2026-02-01', duplicate_of_track_id = 't-cert-0000000000000a' where track_id = 't-cert-0000000000000b'",
      ],
      "write",
    );
    await reconcileHubCounts();
    for (const [table, id] of [
      ["labels", "lab-1"],
      ["albums", "alb-1"],
      ["artists", "art-1"],
    ] as const) {
      const stored = await db.execute({
        args: [id],
        sql: `select latest_release_date from ${table} where id = ?`,
      });
      expect(stored.rows[0]?.latest_release_date, table).toBe("2026-01-15");
    }
  });

  it("does not create due work for a date-only correction", async () => {
    await setCounts("labels", "lab-1", { certified: 2, renderable: 3 });
    await setCounts("albums", "alb-1", { certified: 2, renderable: 3 });
    await setCounts("artists", "art-1", { certified: 2, renderable: 3 });
    await db.execute("update artists set rankable_track_count = 1 where id = 'art-1'");
    await db.execute(
      "update tracks set release_date = '2026-01-15' where track_id = 't-cert-0000000000000a'",
    );
    const result = await reconcileHubCounts();
    expect(result.labels).toEqual({ corrected: 0, deferred: 0, latestCorrected: 1 });
    expect(result.albums).toEqual({ corrected: 0, deferred: 0, latestCorrected: 1 });
    expect(result.artists).toEqual({ corrected: 0, deferred: 0, latestCorrected: 1 });
    const markers = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND],
      sql: "select subject_id from due_work where work_kind = ?",
    });
    expect(markers.rows).toHaveLength(0);
  });
});

describe("latest date guard", () => {
  it("re-reads once and defers a date correction whose guard loses twice", async () => {
    await reconcileHubCounts();
    await db.execute(
      "update tracks set release_date = '2026-01-15' where track_id = 't-cert-0000000000000a'",
    );
    let moves = 0;
    wrapped = recordingClient(db, async (statements) => {
      if (
        moves < 2 &&
        statements.some((statement) =>
          sqlOf(statement).includes("update labels set latest_release_date"),
        )
      ) {
        moves += 1;
        await db.execute({
          args: [moves === 1 ? "2025-01-01" : "2024-01-01"],
          sql: "update labels set latest_release_date = ? where id = 'lab-1'",
        });
      }
    }).client;
    const result = await reconcileHubCounts();
    expect(result.labels).toEqual({ corrected: 0, deferred: 1, latestCorrected: 0 });
    const stored = await db.execute("select latest_release_date from labels where id = 'lab-1'");
    expect(stored.rows[0]?.latest_release_date).toBe("2024-01-01");
  });
});
