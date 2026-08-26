import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";
import {
  claimDueWork,
  compareDueWorkRows,
  deleteDueWork,
  hasReadyDueWork,
  listReadyDueWork,
  markDueWorkRepair,
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
  });
});
