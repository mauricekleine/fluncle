import { type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => undefined }));
import { HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY } from "../health-receipt-cutover";
import { createIntegrationDb } from "../integration-db";
import {
  healthSnapshotOperationKey,
  healthSnapshotRequestDigest,
  type HealthCheckInput,
} from "../status";
import { recordHealthSnapshotRequestFor } from "./admin-health";
import { healthSnapshotReceiptMetadata } from "../../../../../../docs/agents/hermes/scripts/fluncle-healthcheck";

const PRODUCER = "handler-test";
const OFFSET_AT = "2026-08-26T14:00:00+02:00";
const UTC_AT = "2026-08-26T12:00:00.000Z";
const CHECK: HealthCheckInput = {
  latencyMs: 7,
  message: "  ready   now ",
  service: " web ",
  status: "ok",
  transitioned: true,
};

let db: Client;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fluncle-admin-health-"));
  db = await createIntegrationDb({ url: `file:${join(directory, "health.db")}` });
});

afterEach(async () => {
  db.close();
  await rm(directory, { force: true, recursive: true });
});

async function enableReceipts(): Promise<void> {
  await db.execute({
    args: [HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY, "true"],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
}

async function receiptInput() {
  return {
    at: OFFSET_AT,
    checks: [CHECK],
    operationKey: healthSnapshotOperationKey(PRODUCER, OFFSET_AT),
    producer: PRODUCER,
    requestDigest: await healthSnapshotRequestDigest(PRODUCER, OFFSET_AT, [CHECK]),
  };
}

describe("admin health receipt cutover", () => {
  it("rejects keyless writes while the cutover is enabled", async () => {
    await enableReceipts();

    const failure = recordHealthSnapshotRequestFor(db, { at: OFFSET_AT, checks: [CHECK] });
    await expect(failure).rejects.toMatchObject({
      code: "operation_receipt_required",
      status: 400,
    });
    await expect(rowCount("service_status")).resolves.toBe(0);
  });

  it("preserves keyless, initialization-key, and receipt-shaped writes while default-off", async () => {
    await recordHealthSnapshotRequestFor(db, { at: OFFSET_AT, checks: [CHECK] });
    await recordHealthSnapshotRequestFor(db, {
      at: OFFSET_AT,
      checks: [CHECK],
      operationKey: `health.snapshot:${UTC_AT}`,
    });
    await recordHealthSnapshotRequestFor(db, await receiptInput());

    await expect(rowCount("operation_receipts")).resolves.toBe(0);
    const status = await db.execute(
      "select service, message, checked_at from service_status where service = 'web'",
    );
    expect(status.rows[0]).toMatchObject({
      checked_at: UTC_AT,
      message: "ready now",
      service: "web",
    });
  });

  it("requires the full receipt shape from initialization-era callers after flag-on", async () => {
    await enableReceipts();

    await expect(
      recordHealthSnapshotRequestFor(db, {
        at: OFFSET_AT,
        checks: [CHECK],
        operationKey: `health.snapshot:${UTC_AT}`,
      }),
    ).rejects.toMatchObject({ code: "operation_receipt_required", status: 400 });
    await expect(rowCount("service_status")).resolves.toBe(0);
  });

  it("verifies canonical key and digest before executing the receipt-backed effect", async () => {
    await enableReceipts();
    const input = await receiptInput();
    await recordHealthSnapshotRequestFor(db, input);

    const receipt = await db.execute(
      "select operation_key, request_digest, state from operation_receipts",
    );
    expect(receipt.rows[0]).toMatchObject({
      operation_key: healthSnapshotOperationKey(PRODUCER, UTC_AT),
      request_digest: input.requestDigest,
      state: "committed",
    });

    await expect(
      recordHealthSnapshotRequestFor(db, { ...input, requestDigest: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "operation_receipt_digest_mismatch", status: 409 });
    await expect(rowCount("operation_receipts")).resolves.toBe(1);
  });

  it("accepts the main caller's canonical receipt metadata without translation", async () => {
    await enableReceipts();
    const caller = await healthSnapshotReceiptMetadata(OFFSET_AT, [
      { ...CHECK, transitioned: true },
    ]);

    expect(caller.requestDigest).toBe(
      await healthSnapshotRequestDigest(caller.producer, caller.at, caller.checks),
    );
    await recordHealthSnapshotRequestFor(db, caller);
    await expect(rowCount("operation_receipts")).resolves.toBe(1);
  });

  it("gives independent producers collision-free keys while keeping retries stable", () => {
    expect(healthSnapshotOperationKey(PRODUCER, OFFSET_AT)).toBe(
      healthSnapshotOperationKey(PRODUCER, UTC_AT),
    );
    expect(healthSnapshotOperationKey("another-producer", OFFSET_AT)).not.toBe(
      healthSnapshotOperationKey(PRODUCER, OFFSET_AT),
    );
  });
});

async function rowCount(table: "operation_receipts" | "service_status"): Promise<number> {
  const result = await db.execute(`select count(*) as count from ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}
