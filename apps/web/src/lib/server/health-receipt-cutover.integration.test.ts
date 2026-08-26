import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";

import {
  HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY,
  getHealthSnapshotReceiptCutoverDispositionFor,
  isHealthSnapshotReceiptCutoverEnabledFor,
} from "./health-receipt-cutover";
import { createIntegrationDb } from "./integration-db";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

async function setFlag(value: string): Promise<void> {
  await db.execute({
    args: [HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY, value],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
}

describe("health snapshot receipt cutover", () => {
  it("stays default-off for missing and malformed values", async () => {
    expect(await isHealthSnapshotReceiptCutoverEnabledFor(db)).toBe(false);

    await setFlag("TRUE");
    expect(await isHealthSnapshotReceiptCutoverEnabledFor(db)).toBe(false);

    await setFlag("false");
    expect(await isHealthSnapshotReceiptCutoverEnabledFor(db)).toBe(false);
  });

  it("opens only for the exact true value", async () => {
    await setFlag("true");

    expect(await isHealthSnapshotReceiptCutoverEnabledFor(db)).toBe(true);
  });

  it("fails closed when the settings read fails", async () => {
    await db.execute(`drop table settings`);

    expect(await isHealthSnapshotReceiptCutoverEnabledFor(db)).toBe(false);
    expect(await getHealthSnapshotReceiptCutoverDispositionFor(db)).toBe("unavailable");
  });
});
