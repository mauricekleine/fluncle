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
      const operationKey = healthSnapshotOperationKey(AT);
      const first = await recordHealthSnapshotWithReceiptFor(client, operationKey, AT, CHECKS);
      const replay = await recordHealthSnapshotWithReceiptFor(client, operationKey, AT, CHECKS);

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
      const operationKey = healthSnapshotOperationKey(AT);
      await recordHealthSnapshotWithReceiptFor(client, operationKey, AT, CHECKS);
      const conflict = await recordHealthSnapshotWithReceiptFor(client, operationKey, AT, [
        { ...CHECK, status: "down" },
      ]);

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
        healthSnapshotOperationKey(AT),
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
