import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DUE_WORK_SOURCE_REPAIR_KIND,
  type DueWorkClient,
  type DueWorkRepairDefinition,
  markDueWorkRepair,
  markDueWorkSourceRepairsStatement,
} from "./due-work";
import { dueWorkRepairDefinitions } from "./due-work-registry";
import {
  CATALOGUE_RANK_CORPUS_CHECK_KEY,
  fanOutDueWorkSourceRepairs,
  findPendingPhysicalRepairDefinition,
  RANK_REBUILD_LIMIT,
} from "./due-work-source-repair";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedConvergedDueWorkRebuilds,
  seedTrack,
} from "./integration-db";
import { advanceProjectionFor } from "./projection-operations";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  await seedConvergedDueWorkRebuilds(db);
});

afterEach(() => {
  db.close();
});

type Trace = { corpusReads: number; physicalProbes: number; rankPageCursors: string[] };

function newTrace(): Trace {
  return { corpusReads: 0, physicalProbes: 0, rankPageCursors: [] };
}

function tracedClient(trace: Trace) {
  return {
    batch: db.batch.bind(db),
    execute: async (statement: InStatement | string) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.includes("from findings cross join tracks ft")) {
        trace.corpusReads += 1;
      }
      if (sql.includes("select work_kind, subject_type from due_work")) {
        trace.physicalProbes += 1;
      }
      if (
        typeof statement !== "string" &&
        Array.isArray(statement.args) &&
        sql.includes("t.catalogue_rank_corpus") &&
        sql.includes("where t.track_id > ?")
      ) {
        const cursor = statement.args[0];
        if (typeof cursor !== "string") {
          throw new Error("catalogue-rank page cursor is not a string");
        }
        trace.rankPageCursors.push(cursor);
      }
      return typeof statement === "string" ? db.execute(statement) : db.execute(statement);
    },
  };
}

function rankMarker(markerVersion: string): InStatement {
  return markDueWorkSourceRepairsStatement(
    [{ subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID, subjectType: "track" }],
    { markerVersion, producer: "catalogue-rank" },
  );
}

async function readRankRebuild() {
  return (
    await db.execute(`select generation, scanned_count, state from due_work_rebuilds
      where work_kind = 'catalogue-rank' and subject_type = 'track'`)
  ).rows[0];
}

async function readRankMarkerVersion(): Promise<unknown> {
  return (
    await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND, DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID],
      sql: `select source_version from due_work where work_kind = ? and subject_id = ?`,
    })
  ).rows[0]?.source_version;
}

async function insertPlainTracks(trackIds: readonly string[]): Promise<void> {
  await db.execute({
    args: trackIds.flatMap((trackId) => [
      trackId,
      `Track ${trackId}`,
      '["Test Artist"]',
      `spotify:track:${trackId}`,
      270_000,
    ]),
    sql: `insert into tracks
      (track_id, title, artists_json, spotify_uri, duration_ms)
      values ${trackIds.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
  });
}

async function countRankRows(where: string, args: string[] = []): Promise<number> {
  return Number(
    (
      await db.execute({
        args: ["catalogue-rank", ...args],
        sql: `select count(*) as n from due_work where work_kind = ? and ${where}`,
      })
    ).rows[0]?.n ?? 0,
  );
}

/** The per-definition probe loop the single repair-index read must agree with. */
async function firstPendingDefinitionByDefinitionProbe(
  client: DueWorkClient,
): Promise<DueWorkRepairDefinition<string> | undefined> {
  for (const definition of dueWorkRepairDefinitions(client)) {
    const pending = await client.execute({
      args: [definition.workKind, definition.subjectType],
      sql: `select 1 from due_work
        where work_kind = ? and subject_type = ? and state = 'repair' limit 1`,
    });
    if (pending.rows.length > 0) {
      return definition;
    }
  }
  return undefined;
}

function identityOf(definition: DueWorkRepairDefinition<string> | undefined) {
  return definition === undefined
    ? undefined
    : { subjectType: definition.subjectType, workKind: definition.workKind };
}

describe("track due-work repair pace", () => {
  it("reads the rank corpus once per marker version and clears the marker when its unchanged generation completes", async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedCatalogueTrack(db, { trackId: `steady-${index}` });
    }
    const trace = newTrace();
    const client = tracedClient(trace);
    await db.execute(rankMarker("steady-v1"));

    expect(await fanOutDueWorkSourceRepairs(client, { limit: 2 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 2,
    });
    const generation = (await readRankRebuild())?.generation;
    expect(typeof generation).toBe("string");
    expect(trace.corpusReads).toBe(1);

    await db.execute(rankMarker("steady-v2-same-corpus"));
    expect(await fanOutDueWorkSourceRepairs(client, { limit: 2 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 2,
    });
    expect(trace.corpusReads).toBe(2);
    expect(await readRankRebuild()).toMatchObject({
      generation,
      scanned_count: 4,
      state: "running",
    });
    const check = (
      await db.execute({
        args: [CATALOGUE_RANK_CORPUS_CHECK_KEY],
        sql: `select value from settings where key = ?`,
      })
    ).rows[0]?.value;
    if (typeof check !== "string") {
      throw new Error("catalogue-rank corpus check was not recorded");
    }
    expect(JSON.parse(check)).toEqual({
      generation,
      markerVersion: "steady-v2-same-corpus",
    });

    expect(await fanOutDueWorkSourceRepairs(client, { limit: 2 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 1,
    });
    expect(await fanOutDueWorkSourceRepairs(client, { limit: 2 })).toMatchObject({
      deferred: 0,
      expanded: 1,
      hasMore: false,
      rankRebuildScanned: 0,
    });
    expect(trace.corpusReads).toBe(2);
    expect(trace.rankPageCursors).toEqual(["", "steady-1", "steady-3", "steady-4"]);
    expect(await readRankRebuild()).toMatchObject({
      generation,
      scanned_count: 5,
      state: "complete",
    });
    expect(await readRankMarkerVersion()).toBeUndefined();
  });

  it("restarts a running rank generation from page zero as soon as a newer marker proves its corpus changed", async () => {
    for (let index = 0; index < 8; index += 1) {
      await seedCatalogueTrack(db, { trackId: `drift-${index}` });
    }
    const trace = newTrace();
    const client = tracedClient(trace);
    await db.execute(rankMarker("drift-v1"));

    expect(await fanOutDueWorkSourceRepairs(client, { limit: 2 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 2,
    });
    expect(await fanOutDueWorkSourceRepairs(client, { limit: 2 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 2,
    });
    const firstGeneration = (await readRankRebuild())?.generation;
    if (typeof firstGeneration !== "string") {
      throw new Error("catalogue-rank generation is missing");
    }
    expect(trace.corpusReads).toBe(1);

    await seedTrack(db, { logId: "001.1.1A", trackId: "drift-finding" });
    await db.execute(rankMarker("drift-v2-changed-corpus"));
    expect(await fanOutDueWorkSourceRepairs(client, { limit: 2 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 2,
    });
    const restarted = await readRankRebuild();
    const restartedGeneration = restarted?.generation;
    expect(restartedGeneration).not.toBe(firstGeneration);
    expect(restarted).toMatchObject({ scanned_count: 2, state: "running" });
    expect(trace.rankPageCursors).toEqual(["", "drift-1", ""]);
    expect(trace.corpusReads).toBe(2);
    expect(await readRankMarkerVersion()).toBe("drift-v2-changed-corpus");

    let completed = false;
    for (let step = 0; step < 8 && !completed; step += 1) {
      const result = await fanOutDueWorkSourceRepairs(client, { limit: 2 });
      completed = result.expanded === 1;
    }
    expect(completed).toBe(true);
    expect(trace.corpusReads).toBe(2);
    expect(trace.rankPageCursors).toEqual([
      "",
      "drift-1",
      "",
      "drift-1",
      "drift-3",
      "drift-5",
      "drift-7",
      "drift-finding",
    ]);
    expect(await readRankRebuild()).toMatchObject({
      generation: restartedGeneration,
      scanned_count: 9,
      state: "complete",
    });
    expect(await countRankRows("generation = ?", [firstGeneration])).toBe(0);
    expect(await readRankMarkerVersion()).toBeUndefined();
  });

  it("advances catalogue-rank rebuild pages of up to 500 rows as one per-row upsert batch", async () => {
    expect(RANK_REBUILD_LIMIT).toBe(500);
    await insertPlainTracks(
      Array.from(
        { length: RANK_REBUILD_LIMIT + 1 },
        (_, index) => `page-${String(index).padStart(3, "0")}`,
      ),
    );
    await db.execute(rankMarker("page-v1"));
    let maximumBatchStatements = 0;
    let maximumStatementArgs = 0;
    let compoundSelects = 0;
    const client = {
      batch: async (statements: InStatement[], mode?: Parameters<Client["batch"]>[1]) => {
        maximumBatchStatements = Math.max(maximumBatchStatements, statements.length);
        for (const statement of statements) {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (/\b(union|intersect|except)\b/i.test(sql)) {
            compoundSelects += 1;
          }
          if (typeof statement !== "string" && Array.isArray(statement.args)) {
            maximumStatementArgs = Math.max(maximumStatementArgs, statement.args.length);
          }
        }
        return db.batch(statements, mode);
      },
      execute: db.execute.bind(db),
    };

    expect(await fanOutDueWorkSourceRepairs(client)).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 500,
    });
    expect({ compoundSelects, maximumBatchStatements, maximumStatementArgs }).toEqual({
      compoundSelects: 0,
      maximumBatchStatements: 501,
      maximumStatementArgs: 14,
    });
    expect(await readRankRebuild()).toMatchObject({ scanned_count: 500, state: "running" });
    expect(await countRankRows("state = 'ready'")).toBe(500);

    expect(await fanOutDueWorkSourceRepairs(client, { limit: 100 })).toMatchObject({
      deferred: 1,
      rankRebuildScanned: 1,
    });
    expect(await fanOutDueWorkSourceRepairs(client)).toMatchObject({
      deferred: 0,
      expanded: 1,
      rankRebuildScanned: 0,
    });
    expect(await readRankRebuild()).toMatchObject({ scanned_count: 501, state: "complete" });
    expect(await countRankRows("state = 'ready'")).toBe(501);
  });

  it("finds physical repair debt with one indexed read wherever the per-definition probe finds it", async () => {
    const definitions = dueWorkRepairDefinitions(db);
    const first = definitions[0];
    const last = definitions.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("due-work repair registry is empty");
    }
    const trace = newTrace();
    const client = tracedClient(trace);

    await seedCatalogueTrack(db, { trackId: "probe-source" });
    await db.batch(
      [
        markDueWorkSourceRepairsStatement([{ subjectId: "probe-source", subjectType: "track" }], {
          markerVersion: "probe-source-v1",
          producer: "capture-verification",
        }),
        rankMarker("probe-rank-v1"),
      ],
      "write",
    );
    expect(await firstPendingDefinitionByDefinitionProbe(db)).toBeUndefined();
    expect(await findPendingPhysicalRepairDefinition(client)).toBeUndefined();
    expect(trace.physicalProbes).toBe(1);

    await markDueWorkRepair(db, {
      sourceVersion: "late-v1",
      subjectId: "late-subject",
      subjectType: last.subjectType,
      workKind: last.workKind,
    });
    expect(identityOf(await firstPendingDefinitionByDefinitionProbe(db))).toEqual(identityOf(last));
    expect(identityOf(await findPendingPhysicalRepairDefinition(client))).toEqual(identityOf(last));
    expect(trace.physicalProbes).toBe(2);

    await markDueWorkRepair(db, {
      sourceVersion: "early-v1",
      subjectId: "probe-source",
      subjectType: first.subjectType,
      workKind: first.workKind,
    });
    expect(identityOf(await firstPendingDefinitionByDefinitionProbe(db))).toEqual(
      identityOf(first),
    );
    expect([identityOf(first), identityOf(last)]).toContainEqual(
      identityOf(await findPendingPhysicalRepairDefinition(client)),
    );
    expect(trace.physicalProbes).toBe(3);
  });

  it("drains zero debt and a late registered definition with one physical probe per repair step", async () => {
    const last = dueWorkRepairDefinitions(db).at(-1);
    if (last === undefined) {
      throw new Error("due-work repair registry is empty");
    }
    const trace = newTrace();
    const client = tracedClient(trace);

    expect(
      await advanceProjectionFor(client, {
        action: "repair",
        includeStatus: false,
        limit: 500,
        target: "track_due_work",
      }),
    ).toMatchObject({ complete: true, processed: 0, status: undefined });
    expect(trace.physicalProbes).toBe(1);

    await markDueWorkRepair(db, {
      sourceVersion: "late-drain-v1",
      subjectId: "late-drain",
      subjectType: last.subjectType,
      workKind: last.workKind,
    });
    expect(
      await advanceProjectionFor(client, {
        action: "repair",
        includeStatus: false,
        limit: 500,
        target: "track_due_work",
      }),
    ).toMatchObject({ complete: true, processed: 1, status: undefined });
    expect(trace.physicalProbes).toBe(2);
    expect(
      (await db.execute(`select work_kind from due_work where state = 'repair'`)).rows,
    ).toEqual([]);
  });

  it("keeps an unregistered repair marker from hiding registered debt behind it in index order", async () => {
    const trace = newTrace();
    const client = tracedClient(trace);
    await seedCatalogueTrack(db, { trackId: "hidden-track" });
    await markDueWorkRepair(db, {
      sourceVersion: "retired-v1",
      subjectId: "retired-album",
      subjectType: "album",
      workKind: "retired-kind",
    });

    expect(await findPendingPhysicalRepairDefinition(client)).toBeUndefined();
    expect(trace.physicalProbes).toBe(2);

    await markDueWorkRepair(db, {
      sourceVersion: "hidden-v1",
      subjectId: "hidden-track",
      subjectType: "track",
      workKind: "artist-edges",
    });
    expect(identityOf(await findPendingPhysicalRepairDefinition(client))).toEqual({
      subjectType: "track",
      workKind: "artist-edges",
    });
    expect(trace.physicalProbes).toBe(4);
  });
});
