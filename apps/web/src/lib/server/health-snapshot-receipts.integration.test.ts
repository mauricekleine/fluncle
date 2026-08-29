import { type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIntegrationDb } from "./integration-db";
import {
  healthSnapshotOperationKey,
  recordHealthSnapshotWithReceiptFor,
  type HealthCheckInput,
} from "./status";

const AT = "2026-08-26T12:00:00.000Z";
const PRODUCER = "test-health";
const CHECK: HealthCheckInput = {
  latencyMs: 42,
  message: "ready",
  service: "web",
  status: "ok",
  transitioned: true,
};
const CHECKS: HealthCheckInput[] = [CHECK];

describe("receipt-backed health snapshots", () => {
  it("replays one terminal result without duplicating any effect", async () => {
    await withFileDb(async (client) => {
      const operationKey = healthSnapshotOperationKey(PRODUCER, AT);
      const first = await recordHealthSnapshotWithReceiptFor(
        client,
        operationKey,
        PRODUCER,
        AT,
        CHECKS,
      );
      const replay = await recordHealthSnapshotWithReceiptFor(
        client,
        operationKey,
        PRODUCER,
        AT,
        CHECKS,
      );

      expect(first).toMatchObject({ outcome: "committed", replayed: false });
      expect(replay).toMatchObject({
        outcome: "committed",
        replayed: true,
        resultIdentity: operationKey,
      });
      await expect(count(client, "status_events")).resolves.toBe(1);
      await expect(count(client, "service_check_samples")).resolves.toBe(1);
      await expect(count(client, "operation_receipts")).resolves.toBe(1);
    });
  });

  it("rejects a changed request under the same operation key", async () => {
    await withFileDb(async (client) => {
      const operationKey = healthSnapshotOperationKey(PRODUCER, AT);
      await recordHealthSnapshotWithReceiptFor(client, operationKey, PRODUCER, AT, CHECKS);
      const conflict = await recordHealthSnapshotWithReceiptFor(
        client,
        operationKey,
        PRODUCER,
        AT,
        [{ ...CHECK, status: "down" }],
      );

      expect(conflict).toEqual({ outcome: "conflict", replayed: false });
      const status = await client.execute(
        "select status from service_status where service = 'web'",
      );
      expect(status.rows[0]?.status).toBe("ok");
      await expect(count(client, "status_events")).resolves.toBe(1);
      await expect(count(client, "service_check_samples")).resolves.toBe(1);
    });
  });

  it("rolls the entire snapshot back when an effect write fails", async () => {
    await withFileDb(async (client) => {
      await client.execute(`create trigger reject_health_sample
        before insert on service_check_samples
        begin
          select raise(abort, 'sample rejected');
        end`);

      const outcome = await recordHealthSnapshotWithReceiptFor(
        client,
        healthSnapshotOperationKey(PRODUCER, AT),
        PRODUCER,
        AT,
        CHECKS,
      );

      expect(outcome).toEqual({ outcome: "safely-retryable", replayed: false });
      await expect(count(client, "service_status")).resolves.toBe(0);
      await expect(count(client, "status_events")).resolves.toBe(0);
      await expect(count(client, "service_check_samples")).resolves.toBe(0);
      await expect(count(client, "operation_receipts")).resolves.toBe(0);
    });
  });

  it("commits rate-limit pruning with the snapshot and does not repeat it on replay", async () => {
    await withFileDb(async (client) => {
      await insertRateLimit(client, "old", "2026-08-01T00:00:00.000Z");
      await insertRateLimit(client, "fresh", "2026-08-26T11:00:00.000Z");
      const operationKey = healthSnapshotOperationKey(PRODUCER, AT);

      await recordHealthSnapshotWithReceiptFor(client, operationKey, PRODUCER, AT, CHECKS);
      expect(await rateLimitBuckets(client)).toEqual(["fresh"]);

      await insertRateLimit(client, "after-commit", "2026-08-01T00:00:00.000Z");
      await recordHealthSnapshotWithReceiptFor(client, operationKey, PRODUCER, AT, CHECKS);
      expect(await rateLimitBuckets(client)).toEqual(["after-commit", "fresh"]);
    });
  });

  it("rolls rate-limit pruning back when receipt terminalization fails", async () => {
    await withFileDb(async (client) => {
      await insertRateLimit(client, "old", "2026-08-01T00:00:00.000Z");
      await client.execute(`create trigger reject_health_receipt_terminal
        before update on operation_receipts
        when new.operation_id = 'health.snapshot' and new.state = 'committed'
        begin
          select raise(abort, 'terminal receipt rejected');
        end`);

      const outcome = await recordHealthSnapshotWithReceiptFor(
        client,
        healthSnapshotOperationKey(PRODUCER, AT),
        PRODUCER,
        AT,
        CHECKS,
      );

      expect(outcome).toEqual({ outcome: "safely-retryable", replayed: false });
      expect(await rateLimitBuckets(client)).toEqual(["old"]);
      await expect(count(client, "service_status")).resolves.toBe(0);
      await expect(count(client, "operation_receipts")).resolves.toBe(0);
    });
  });
});

async function withFileDb(run: (client: Client) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "fluncle-health-receipts-"));
  const client = await createIntegrationDb({ url: `file:${join(directory, "health.db")}` });

  try {
    await run(client);
  } finally {
    client.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function count(client: Client, table: string): Promise<number> {
  const allowedTables = new Set([
    "operation_receipts",
    "rate_limit_counters",
    "service_check_samples",
    "service_status",
    "status_events",
  ]);
  if (!allowedTables.has(table)) {
    throw new Error("unexpected table");
  }

  const result = await client.execute(`select count(*) as count from ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function insertRateLimit(client: Client, bucket: string, windowStart: string): Promise<void> {
  await client.execute({
    args: [bucket, windowStart],
    sql: `insert into rate_limit_counters (action, bucket, window_start, count)
      values ('test', ?, ?, 1)`,
  });
}

async function rateLimitBuckets(client: Client): Promise<unknown[]> {
  const result = await client.execute("select bucket from rate_limit_counters order by bucket");
  return result.rows.map((row) => row.bucket);
}
