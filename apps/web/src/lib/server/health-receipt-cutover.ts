import { type Client } from "@libsql/client";

import { getSetting } from "./settings";

export const HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY = "health_snapshot_receipts_enabled";

export type HealthReceiptCutoverClient = Pick<Client, "execute">;
export type HealthReceiptCutoverDisposition = "disabled" | "enabled" | "unavailable";

export async function getHealthSnapshotReceiptCutoverDisposition(): Promise<HealthReceiptCutoverDisposition> {
  try {
    return (await getSetting(HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY)) === "true"
      ? "enabled"
      : "disabled";
  } catch {
    return "unavailable";
  }
}

export async function isHealthSnapshotReceiptCutoverEnabled(): Promise<boolean> {
  return (await getHealthSnapshotReceiptCutoverDisposition()) === "enabled";
}

export async function isHealthSnapshotReceiptCutoverEnabledFor(
  client: HealthReceiptCutoverClient,
): Promise<boolean> {
  return (await getHealthSnapshotReceiptCutoverDispositionFor(client)) === "enabled";
}

export async function getHealthSnapshotReceiptCutoverDispositionFor(
  client: HealthReceiptCutoverClient,
): Promise<HealthReceiptCutoverDisposition> {
  try {
    const result = await client.execute({
      args: [HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY],
      sql: `select value from settings where key = ? limit 1`,
    });
    return result.rows[0]?.value === "true" ? "enabled" : "disabled";
  } catch {
    return "unavailable";
  }
}
