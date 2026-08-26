import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createIntegrationDb } from "./integration-db";

let db: Client;

const QUEUED = {
  contenderId: "contender-a",
  enqueuedAtMs: 1_000,
  lane: "write",
  operationId: "track.enrich",
  ownerId: "fluncle-enrich",
  runId: "run-a",
};

async function insertQueued(overrides: Partial<typeof QUEUED> = {}): Promise<void> {
  const row = { ...QUEUED, ...overrides };

  await db.execute({
    args: [
      row.contenderId,
      row.lane,
      row.operationId,
      row.ownerId,
      row.runId,
      row.enqueuedAtMs,
      row.enqueuedAtMs,
      row.enqueuedAtMs,
    ],
    sql: `insert into database_admission_contenders
      (contender_id, lane, operation_id, owner_id, run_id, state, enqueued_at_ms,
       queue_heartbeat_at_ms, updated_at_ms)
      values (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("database admission expansion schema", () => {
  it("is inert after migration and preserves both monotone fence lanes", async () => {
    const empty = await db.execute(
      `select
         (select count(*) from database_admission_lanes) as lanes,
         (select count(*) from database_admission_contenders) as contenders`,
    );

    expect(empty.rows[0]).toMatchObject({ contenders: 0, lanes: 0 });

    await db.batch(
      [
        {
          args: ["write", 4, 1_000],
          sql: `insert into database_admission_lanes
            (lane, next_fencing_token, updated_at_ms) values (?, ?, ?)`,
        },
        {
          args: ["heavy-read", 9, 1_000],
          sql: `insert into database_admission_lanes
            (lane, next_fencing_token, updated_at_ms) values (?, ?, ?)`,
        },
      ],
      "write",
    );

    const lanes = await db.execute(
      `select lane, next_fencing_token from database_admission_lanes order by lane`,
    );
    expect(lanes.rows).toEqual([
      { lane: "heavy-read", next_fencing_token: 9 },
      { lane: "write", next_fencing_token: 4 },
    ]);
  });

  it("enforces one active contender per lane and a complete active lifecycle", async () => {
    await insertQueued();
    await db.execute({
      args: [1_100, 1, 91_100, 1_100, QUEUED.contenderId],
      sql: `update database_admission_contenders
        set state = 'active', acquired_at_ms = ?, fencing_token = ?, lease_expires_at_ms = ?,
            updated_at_ms = ?
        where contender_id = ?`,
    });

    await insertQueued({ contenderId: "contender-b", runId: "run-b" });
    await expect(
      db.execute({
        args: [1_200, 2, 91_200, 1_200, "contender-b"],
        sql: `update database_admission_contenders
          set state = 'active', acquired_at_ms = ?, fencing_token = ?, lease_expires_at_ms = ?,
              updated_at_ms = ?
          where contender_id = ?`,
      }),
    ).rejects.toThrow();

    await expect(
      db.execute({
        args: ["invalid-active", "heavy-read", "database.backup", "fluncle-backup", "run-c"],
        sql: `insert into database_admission_contenders
          (contender_id, lane, operation_id, owner_id, run_id, state, enqueued_at_ms,
           queue_heartbeat_at_ms, updated_at_ms)
          values (?, ?, ?, ?, ?, 'active', 1000, 1000, 1000)`,
      }),
    ).rejects.toThrow();
  });
});
