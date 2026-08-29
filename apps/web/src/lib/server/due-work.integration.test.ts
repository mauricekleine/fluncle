import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";
import {
  batchDueWorkSourceMutation,
  clearDueWorkSourceRepairStatement,
  claimDueWork,
  compareDueWorkRows,
  deleteDueWork,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DUE_WORK_LIVE_GENERATION,
  DUE_WORK_SOURCE_REPAIR_KIND,
  hasReadyDueWork,
  listReadyDueWork,
  markDueWorkRepair,
  markDueWorkSourceMaintenanceFromSelectStatements,
  markDueWorkSourceRepairsStatement,
  readDueWorkProjectionChunk,
  readDueWorkRebuild,
  repairDueWorkChunk,
  runDueWorkRebuildChunk,
  runDueWorkRebuildToCompletion,
  startDueWorkRebuild,
  upsertDueWork,
  type DueWorkProjection,
  type DueWorkRebuildDefinition,
  type DueWorkRebuildSource,
} from "./due-work";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:00:01.000Z");
const T2 = new Date("2026-01-01T00:00:02.000Z");
const T3 = new Date("2026-01-01T00:00:03.000Z");
const T4 = new Date("2026-01-01T00:00:04.000Z");

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

function ready(
  subjectId: string,
  sortKey: string,
  workKind = "sample-ready",
): DueWorkProjection<string> {
  return {
    nextDueAt: T0.toISOString(),
    sortKey,
    sourceVersion: `v-${subjectId}`,
    state: "ready",
    subjectId,
    subjectType: "track",
    workKind,
  };
}

describe("due-work ready reads and leases", () => {
  it("reads an empty queue and returns ordered limit-plus-one pages without a count scan", async () => {
    expect(await hasReadyDueWork(db, "sample-ready")).toBe(false);
    expect(await listReadyDueWork(db, "sample-ready", { limit: 2 })).toEqual({
      hasMore: false,
      items: [],
    });

    await Promise.all([
      upsertDueWork(db, ready("track-c", "03"), { now: T0 }),
      upsertDueWork(db, ready("track-a", "01"), { now: T0 }),
      upsertDueWork(db, ready("track-b", "02"), { now: T0 }),
    ]);
    await markDueWorkRepair(
      db,
      {
        sourceVersion: "repair-v1",
        subjectId: "track-repair",
        subjectType: "track",
        workKind: "sample-ready",
      },
      { now: T0 },
    );

    const page = await listReadyDueWork(db, "sample-ready", { limit: 2 });
    expect(page.items.map((item) => item.subjectId)).toEqual(["track-a", "track-b"]);
    expect(page.hasMore).toBe(true);
    expect(await hasReadyDueWork(db, "sample-ready")).toBe(true);
    expect(
      await deleteDueWork(db, {
        subjectId: "track-c",
        subjectType: "track",
        workKind: "sample-ready",
      }),
    ).toBe(true);
  });

  it("atomically separates two claimers, hides leases, and reclaims only after expiry", async () => {
    for (let index = 0; index < 4; index += 1) {
      await upsertDueWork(db, ready(`track-${index}`, `0${index}`, "claim-race"), { now: T0 });
    }

    const [left, right] = await Promise.all([
      claimDueWork(db, "claim-race", {
        claimedBy: "worker-left",
        leaseMs: 1_000,
        limit: 2,
        now: () => T0,
        token: "claim-left",
      }),
      claimDueWork(db, "claim-race", {
        claimedBy: "worker-right",
        leaseMs: 1_000,
        limit: 2,
        now: () => T0,
        token: "claim-right",
      }),
    ]);
    const claimedIds = [...left.items, ...right.items].map((item) => item.subjectId);
    expect(claimedIds).toHaveLength(4);
    expect(new Set(claimedIds).size).toBe(4);
    expect((await listReadyDueWork(db, "claim-race")).items).toEqual([]);

    const beforeExpiry = await claimDueWork(db, "claim-race", {
      claimedBy: "worker-late",
      leaseMs: 1_000,
      limit: 4,
      now: () => new Date("2026-01-01T00:00:00.999Z"),
      token: "claim-too-early",
    });
    expect(beforeExpiry.items).toEqual([]);

    const afterExpiry = await claimDueWork(db, "claim-race", {
      claimedBy: "worker-late",
      leaseMs: 1_000,
      limit: 4,
      now: () => T1,
      token: "claim-after-expiry",
    });
    expect(afterExpiry.reaped).toBe(4);
    expect(afterExpiry.items).toHaveLength(4);
    expect(afterExpiry.items.every((item) => item.claimToken === "claim-after-expiry")).toBe(true);
  });

  it("returns the original lease when a claim token is retried instead of claiming another page", async () => {
    for (let index = 0; index < 4; index += 1) {
      await upsertDueWork(db, ready(`retry-${index}`, `0${index}`, "claim-retry"), { now: T0 });
    }
    const options = {
      claimedBy: "retrying-worker",
      leaseMs: 1_000,
      limit: 2,
      now: () => T0,
      token: "stable-claim-token",
    };

    const first = await claimDueWork(db, "claim-retry", options);
    const retried = await claimDueWork(db, "claim-retry", options);

    expect(first.items.map((row) => row.subjectId)).toEqual(["retry-0", "retry-1"]);
    expect(retried.items.map((row) => row.subjectId)).toEqual(["retry-0", "retry-1"]);
    expect(retried.claimExpiresAt).toBe(first.claimExpiresAt);
    expect((await listReadyDueWork(db, "claim-retry")).items.map((row) => row.subjectId)).toEqual([
      "retry-2",
      "retry-3",
    ]);
  });

  it("promotes scheduled rows only when due and claims them in the same transaction", async () => {
    await upsertDueWork(
      db,
      {
        ...ready("scheduled-track", "01", "scheduled-work"),
        nextDueAt: T2.toISOString(),
        state: "scheduled",
      },
      { now: T0 },
    );

    const early = await claimDueWork(db, "scheduled-work", {
      claimedBy: "worker",
      leaseMs: 1_000,
      limit: 1,
      now: () => T1,
      token: "early",
    });
    expect(early.promoted).toBe(0);
    expect(early.items).toEqual([]);

    const due = await claimDueWork(db, "scheduled-work", {
      claimedBy: "worker",
      leaseMs: 1_000,
      limit: 1,
      now: () => T2,
      token: "due",
    });
    expect(due.promoted).toBe(1);
    expect(due.items.map((item) => item.subjectId)).toEqual(["scheduled-track"]);
  });
});

describe("due-work repair and drift", () => {
  it("rolls back the source mutation when its coupled marker cannot commit", async () => {
    await db.execute(`create table source_probe (id text primary key)`);
    await db.execute(`create trigger reject_source_repair before insert on due_work
      when new.work_kind = 'source-repair'
      begin
        select raise(abort, 'marker rejected');
      end`);

    await expect(
      batchDueWorkSourceMutation(
        db,
        [{ args: ["source-1"], sql: `insert into source_probe (id) values (?)` }],
        [{ subjectId: "source-1", subjectType: "track" }],
        { markerVersion: "source-v1", now: T0, producer: "test-source-writer" },
      ),
    ).rejects.toThrow("marker rejected");

    const source = await db.execute(`select id from source_probe`);
    expect(source.rows).toEqual([]);
  });

  it("rolls back source, legacy marker, and epochs when a public repair marker cannot commit", async () => {
    await db.execute(`create table projection_source_probe (id text primary key)`);
    await db.execute(`create trigger reject_public_repair before insert on projection_repairs
      begin
        select raise(abort, 'public marker rejected');
      end`);

    await expect(
      batchDueWorkSourceMutation(
        db,
        [{ args: ["source-1"], sql: `insert into projection_source_probe (id) values (?)` }],
        [{ subjectId: "source-1", subjectType: "track" }],
        { markerVersion: "source-v1", now: T0, producer: "test-source-writer" },
      ),
    ).rejects.toThrow("public marker rejected");

    expect((await db.execute(`select id from projection_source_probe`)).rows).toEqual([]);
    expect((await db.execute(`select subject_id from due_work`)).rows).toEqual([]);
    expect((await db.execute(`select scope from public_aggregate_state`)).rows).toEqual([]);
    expect((await db.execute(`select scope from artist_qualification_state`)).rows).toEqual([]);
  });

  it("uses one source version and timestamp on both maintenance rails", async () => {
    await db.execute(`create table committed_source_probe (id text primary key)`);
    await batchDueWorkSourceMutation(
      db,
      [{ args: ["source-1"], sql: `insert into committed_source_probe (id) values (?)` }],
      [{ subjectId: "source-1", subjectType: "track" }],
      { markerVersion: "stable-v1", now: T0, producer: "test-source-writer" },
    );

    expect(
      (
        await db.execute(`select source_version, updated_at from due_work
          where work_kind = 'source-repair' and subject_id = 'source-1'`)
      ).rows,
    ).toEqual([{ source_version: "stable-v1", updated_at: T0.toISOString() }]);
    expect(
      (
        await db.execute(`select projection, source_version, updated_at from projection_repairs
          where subject_type = 'track' and subject_id = 'source-1' order by projection`)
      ).rows,
    ).toEqual([
      {
        projection: "artist_qualification",
        source_version: "stable-v1",
        updated_at: T0.toISOString(),
      },
      {
        projection: "public_aggregates",
        source_version: "stable-v1",
        updated_at: T0.toISOString(),
      },
    ]);
  });

  it("does not treat the catalogue-rank corpus marker as a physical track", async () => {
    await db.execute(`create table synthetic_source_probe (id text primary key)`);
    await batchDueWorkSourceMutation(
      db,
      [{ args: ["source-1"], sql: `insert into synthetic_source_probe (id) values (?)` }],
      [
        {
          subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
          subjectType: "track",
        },
      ],
      { markerVersion: "synthetic-v1", now: T0, producer: "test-source-writer" },
    );

    expect((await db.execute(`select subject_id from projection_repairs`)).rows).toEqual([]);
    expect((await db.execute(`select subject_id from due_work`)).rows).toEqual([
      { subject_id: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID },
    ]);
  });

  it("does not create a marker when a guarded source mutation changes no row", async () => {
    await db.execute(
      `create table guarded_source_probe (id text primary key, value text not null)`,
    );
    await db.execute(`insert into guarded_source_probe (id, value) values ('source-1', 'held')`);

    await batchDueWorkSourceMutation(
      db,
      [
        {
          args: ["replacement", "missing"],
          sql: `update guarded_source_probe set value = ? where id = ?`,
        },
      ],
      [{ subjectId: "missing", subjectType: "track" }],
      {
        markerVersion: "guarded-v1",
        now: T0,
        onlyIfLastSourceStatementChanged: true,
        producer: "test-guarded-writer",
      },
    );

    const markers = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND],
      sql: `select subject_id from due_work where work_kind = ?`,
    });
    expect(markers.rows).toEqual([]);
    expect((await db.execute(`select subject_id from projection_repairs`)).rows).toEqual([]);
    expect((await db.execute(`select scope from public_aggregate_state`)).rows).toEqual([]);
    expect((await db.execute(`select scope from artist_qualification_state`)).rows).toEqual([]);
  });

  it("does not advance public epochs when a bounded source selection is empty", async () => {
    await db.execute(`create table selected_source_probe (id text primary key)`);
    await db.batch(
      [
        ...markDueWorkSourceMaintenanceFromSelectStatements(
          "track",
          { sql: `select id as subject_id from selected_source_probe` },
          { markerVersion: "empty-v1", now: T0, producer: "test-selected-writer" },
        ),
        { sql: `update selected_source_probe set id = id` },
      ],
      "write",
    );

    expect((await db.execute(`select subject_id from due_work`)).rows).toEqual([]);
    expect((await db.execute(`select subject_id from projection_repairs`)).rows).toEqual([]);
    expect((await db.execute(`select scope from public_aggregate_state`)).rows).toEqual([]);
    expect((await db.execute(`select scope from artist_qualification_state`)).rows).toEqual([]);
  });

  it("keeps one idempotent source marker per subject and preserves a concurrent rewrite", async () => {
    const source = { subjectId: "repair-track", subjectType: "track" } as const;
    const first = markDueWorkSourceRepairsStatement([source, source], {
      markerVersion: "source-v1",
      now: T0,
      producer: "test-source-writer",
    });

    await db.batch([first, first], "write");
    const idempotent = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND, source.subjectType, source.subjectId],
      sql: `select source_version, state from due_work
        where work_kind = ? and subject_type = ? and subject_id = ?`,
    });
    expect(idempotent.rows).toHaveLength(1);
    expect(idempotent.rows[0]).toMatchObject({ source_version: "source-v1", state: "repair" });

    await db.batch(
      [
        markDueWorkSourceRepairsStatement([source], {
          markerVersion: "source-v2",
          now: T1,
          producer: "test-source-writer",
        }),
        clearDueWorkSourceRepairStatement({ ...source, sourceVersion: "source-v1" }),
      ],
      "write",
    );
    const raced = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND, source.subjectType, source.subjectId],
      sql: `select source_version, state from due_work
        where work_kind = ? and subject_type = ? and subject_id = ?`,
    });
    expect(raced.rows).toHaveLength(1);
    expect(raced.rows[0]).toMatchObject({ source_version: "source-v2", state: "repair" });

    const cleared = await db.execute(
      clearDueWorkSourceRepairStatement({ ...source, sourceVersion: "source-v2" }),
    );
    expect(cleared.rowsAffected).toBe(1);
  });

  it("keeps a newer repair marker when its source version changes during computation", async () => {
    await markDueWorkRepair(
      db,
      {
        sourceVersion: "version-a",
        subjectId: "repair-track",
        subjectType: "track",
        workKind: "repair-kind",
      },
      { now: T0 },
    );
    expect(await hasReadyDueWork(db, "repair-kind")).toBe(false);

    const raced = await repairDueWorkChunk(
      db,
      {
        async project(marker) {
          await markDueWorkRepair(db, { ...marker, sourceVersion: "version-b" }, { now: T1 });
          return {
            nextDueAt: T0.toISOString(),
            sortKey: "01",
            sourceVersion: marker.sourceVersion,
            state: "ready",
            subjectId: marker.subjectId,
            subjectType: marker.subjectType,
            workKind: marker.workKind,
          };
        },
        subjectType: "track",
        workKind: "repair-kind",
      },
      { now: () => T1 },
    );
    expect(raced).toMatchObject({ deferred: 1, repaired: 0, scanned: 1 });
    const marker = await db.execute(
      "select state, source_version from due_work where work_kind = 'repair-kind'",
    );
    expect(marker.rows[0]).toMatchObject({ source_version: "version-b", state: "repair" });

    const converged = await repairDueWorkChunk(
      db,
      {
        project(current) {
          return {
            nextDueAt: T1.toISOString(),
            sortKey: "02",
            sourceVersion: current.sourceVersion,
            state: "ready",
            subjectId: current.subjectId,
            subjectType: current.subjectType,
            workKind: current.workKind,
          };
        },
        subjectType: "track",
        workKind: "repair-kind",
      },
      { now: () => T2 },
    );
    expect(converged).toMatchObject({ deferred: 0, repaired: 1, scanned: 1 });
    expect((await listReadyDueWork(db, "repair-kind")).items[0]?.sourceVersion).toBe("version-b");
  });

  it("reports missing, unexpected, and field-level projection drift in bounded chunks", async () => {
    await upsertDueWork(db, ready("actual-a", "01", "drift-kind"), { now: T0 });
    await upsertDueWork(db, ready("actual-b", "02", "drift-kind"), { now: T0 });
    const actual = await readDueWorkProjectionChunk(
      db,
      { subjectType: "track", workKind: "drift-kind" },
      { limit: 10 },
    );
    const expected = [
      { ...ready("actual-a", "99", "drift-kind"), sourceVersion: "changed" },
      ready("missing-c", "03", "drift-kind"),
    ];
    const drift = compareDueWorkRows(expected, actual.items);

    expect(drift.missing.map((row) => row.subjectId)).toEqual(["missing-c"]);
    expect(drift.unexpected.map((row) => row.subjectId)).toEqual(["actual-b"]);
    expect(drift.mismatched[0]?.fields).toEqual(["sortKey", "sourceVersion"]);
  });
});

type SampleSource = DueWorkRebuildSource & { due: number; sort_key: string };

function sampleDefinition(): DueWorkRebuildDefinition<"sample-rebuild", SampleSource> {
  return {
    project(source, context) {
      return source.due === 0
        ? null
        : {
            generation: context.generation,
            nextDueAt: context.now,
            sortKey: source.sort_key,
            sourceVersion: source.sourceVersion,
            state: "ready",
            subjectId: source.subjectId,
            subjectType: "track",
            workKind: "sample-rebuild",
          };
    },
    async readSourceChunk({ after, client, limit }) {
      const result = await client.execute({
        args: [after ?? "", limit],
        sql: `select id as cursor, id as subject_id, version as source_version, due, sort_key
          from sample_due_source where id > ? order by id limit ?`,
      });
      return (
        result.rows as unknown as {
          cursor: string;
          due: number;
          sort_key: string;
          source_version: string;
          subject_id: string;
        }[]
      ).map((row) => ({
        cursor: row.cursor,
        due: Number(row.due),
        sort_key: row.sort_key,
        sourceVersion: row.source_version,
        subjectId: row.subject_id,
      }));
    },
    subjectType: "track",
    workKind: "sample-rebuild",
  };
}

describe("due-work rebuild", () => {
  it("resumes zero, midpoint, and complete interruptions and converges a new generation", async () => {
    await db.execute(
      "create table sample_due_source (id text primary key, version text not null, due integer not null, sort_key text not null)",
    );
    await db.batch(
      [
        ["source-1", "v1", 1, "01"],
        ["source-2", "v1", 1, "02"],
        ["source-3", "v1", 0, "03"],
        ["source-4", "v1", 1, "04"],
        ["source-5", "v1", 1, "05"],
      ].map((args) => ({
        args,
        sql: "insert into sample_due_source (id, version, due, sort_key) values (?, ?, ?, ?)",
      })),
      "write",
    );
    await upsertDueWork(
      db,
      { ...ready("stale-row", "00", "sample-rebuild"), generation: "stale-generation" },
      { now: T0 },
    );
    const definition = sampleDefinition();

    const zero = await startDueWorkRebuild(db, definition, {
      generation: "generation-1",
      newGeneration: true,
      now: () => T0,
    });
    expect(zero).toMatchObject({
      cursor: null,
      projectedCount: 0,
      scannedCount: 0,
      state: "running",
    });

    const midpoint = await runDueWorkRebuildChunk(db, definition, {
      limit: 2,
      now: () => T1,
    });
    expect(midpoint).toMatchObject({ complete: false, noOp: false, projected: 2, scanned: 2 });
    expect(midpoint.checkpoint).toMatchObject({
      cursor: "source-2",
      projectedCount: 2,
      scannedCount: 2,
    });

    const complete = await runDueWorkRebuildToCompletion(db, definition, {
      limit: 2,
      now: () => T2,
    });
    expect(complete).toMatchObject({ projectedCount: 4, scannedCount: 5, state: "complete" });
    const firstRows = await readDueWorkProjectionChunk(
      db,
      { subjectType: "track", workKind: "sample-rebuild" },
      { generation: "generation-1", limit: 10 },
    );
    expect(firstRows.items.map((row) => row.subjectId)).toEqual([
      "source-1",
      "source-2",
      "source-4",
      "source-5",
    ]);
    expect(await readDueWorkRebuild(db, definition)).toEqual(complete);

    const completeRestart = await runDueWorkRebuildChunk(db, definition, {
      limit: 2,
      now: () => new Date("2026-01-01T00:00:03.000Z"),
    });
    expect(completeRestart).toMatchObject({ complete: true, noOp: true, projected: 0, scanned: 0 });
    expect(completeRestart.checkpoint).toEqual(complete);

    await db.batch(
      [
        { args: ["source-1"], sql: "delete from sample_due_source where id = ?" },
        {
          args: ["v2", "12", "source-2"],
          sql: "update sample_due_source set version = ?, sort_key = ? where id = ?",
        },
        {
          args: ["source-6", "v1", 1, "06"],
          sql: "insert into sample_due_source (id, version, due, sort_key) values (?, ?, ?, ?)",
        },
      ],
      "write",
    );
    const next = await runDueWorkRebuildToCompletion(db, definition, {
      generation: "generation-2",
      limit: 2,
      newGeneration: true,
      now: () => new Date("2026-01-01T00:00:04.000Z"),
    });
    expect(next).toMatchObject({
      generation: "generation-2",
      projectedCount: 4,
      scannedCount: 5,
      state: "complete",
    });
    const secondRows = await readDueWorkProjectionChunk(
      db,
      { subjectType: "track", workKind: "sample-rebuild" },
      { generation: "generation-2", limit: 10 },
    );
    expect(secondRows.items.map((row) => row.subjectId)).toEqual([
      "source-2",
      "source-4",
      "source-5",
      "source-6",
    ]);
    expect(secondRows.items.find((row) => row.subjectId === "source-2")).toMatchObject({
      sortKey: "12",
      sourceVersion: "v2",
    });
    const allRows = await db.execute(
      "select subject_id from due_work where work_kind = 'sample-rebuild' order by subject_id",
    );
    expect(allRows.rows.map((row) => row.subject_id)).toEqual([
      "source-2",
      "source-4",
      "source-5",
      "source-6",
    ]);

    await db.execute({ args: ["source-2"], sql: `delete from sample_due_source where id = ?` });
    let boundedComplete = false;
    for (let chunk = 0; chunk < 10 && !boundedComplete; chunk += 1) {
      const bounded = await runDueWorkRebuildChunk(db, definition, {
        boundedCleanup: true,
        generation: "generation-3",
        limit: 2,
        newGeneration: chunk === 0,
        now: () => new Date("2026-01-01T00:00:05.000Z"),
      });
      expect(bounded.scanned).toBeLessThanOrEqual(2);
      boundedComplete = bounded.complete;
    }
    expect(boundedComplete).toBe(true);
    expect(
      (
        await db.execute(
          `select subject_id from due_work where work_kind = 'sample-rebuild' order by subject_id`,
        )
      ).rows.map((row) => row.subject_id),
    ).toEqual(["source-4", "source-5", "source-6"]);
  });

  it("never overwrites or prunes a live repair that wins after the rebuild source read", async () => {
    let sourceReads = 0;
    const definition: DueWorkRebuildDefinition<"raced-rebuild", SampleSource> = {
      project(source, context) {
        return {
          generation: context.generation,
          nextDueAt: context.now,
          sortKey: source.sort_key,
          sourceVersion: source.sourceVersion,
          state: "ready",
          subjectId: source.subjectId,
          subjectType: "track",
          workKind: "raced-rebuild",
        };
      },
      async readSourceChunk({ after }) {
        if (after !== null) {
          return [];
        }
        sourceReads += 1;

        // The rebuild captured v1. Before its guarded write begins, a transactionally repaired v2
        // projection lands. The older generation must neither overwrite nor prune that winner.
        if (sourceReads === 1) {
          await upsertDueWork(
            db,
            {
              generation: DUE_WORK_LIVE_GENERATION,
              nextDueAt: T3.toISOString(),
              sortKey: "02",
              sourceVersion: "v2",
              state: "ready",
              subjectId: "raced-source",
              subjectType: "track",
              workKind: "raced-rebuild",
            },
            { now: T3 },
          );
        }
        return [
          {
            cursor: "raced-source",
            due: 1,
            sort_key: sourceReads === 1 ? "01" : "02",
            sourceVersion: sourceReads === 1 ? "v1" : "v2",
            subjectId: "raced-source",
          },
        ];
      },
      subjectType: "track",
      workKind: "raced-rebuild",
    };

    const result = await runDueWorkRebuildChunk(db, definition, {
      generation: "backfill-generation",
      limit: 2,
      newGeneration: true,
      now: () => T2,
    });

    expect(result.complete).toBe(true);
    expect((await listReadyDueWork(db, "raced-rebuild")).items[0]).toMatchObject({
      generation: DUE_WORK_LIVE_GENERATION,
      sortKey: "02",
      sourceVersion: "v2",
    });

    await upsertDueWork(
      db,
      {
        generation: DUE_WORK_LIVE_GENERATION,
        nextDueAt: T0.toISOString(),
        sortKey: "00",
        sourceVersion: "unexpected",
        state: "ready",
        subjectId: "unexpected-live",
        subjectType: "track",
        workKind: "raced-rebuild",
      },
      { now: T0 },
    );
    await runDueWorkRebuildToCompletion(db, definition, {
      generation: "converged-generation",
      limit: 2,
      newGeneration: true,
      now: () => T4,
    });
    expect((await listReadyDueWork(db, "raced-rebuild")).items).toMatchObject([
      {
        generation: "converged-generation",
        sortKey: "02",
        sourceVersion: "v2",
        subjectId: "raced-source",
      },
    ]);
    await expect(
      startDueWorkRebuild(db, definition, {
        generation: DUE_WORK_LIVE_GENERATION,
        newGeneration: true,
      }),
    ).rejects.toThrow("reserved");
  });
});
