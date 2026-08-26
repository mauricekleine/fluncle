import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";

import { HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY } from "../health-receipt-cutover";
import { createIntegrationDb } from "../integration-db";
import { inspectLegacyOperationReceiptFor } from "./admin-operation-receipts";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

async function setCutover(value: string): Promise<void> {
  await db.execute({
    args: [HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY, value],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
}

describe("initialization operation receipt inspection", () => {
  it("keeps missing receipts cutover-disabled while the flag is off", async () => {
    await expect(inspectLegacyOperationReceiptFor(db, "missing-key")).resolves.toMatchObject({
      receipt: { outcome: "cutover-disabled" },
    });
  });

  it("authorizes a missing receipt retry only while the flag is on", async () => {
    await setCutover("true");

    await expect(inspectLegacyOperationReceiptFor(db, "missing-key")).resolves.toMatchObject({
      receipt: { outcome: "safely-retryable" },
    });
  });

  it("accepts initialization keys outside the cutover grammar", async () => {
    await expect(inspectLegacyOperationReceiptFor(db, "legacy-🔒")).resolves.toMatchObject({
      receipt: { outcome: "cutover-disabled" },
    });
  });
});
