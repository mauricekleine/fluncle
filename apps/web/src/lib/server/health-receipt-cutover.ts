import { type Client } from "@libsql/client";

import { getSetting } from "./settings";

/** The health snapshot receipt cutover is dark unless the stored value is exactly `true`. */
export const HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY = "health_snapshot_receipts_enabled";

export type HealthReceiptCutoverClient = Pick<Client, "execute">;
export type HealthReceiptCutoverDisposition = "disabled" | "enabled" | "unavailable";

/** Distinguish an absent/default-off flag from a failed read before choosing a write path. */
export async function getHealthSnapshotReceiptCutoverDisposition(): Promise<HealthReceiptCutoverDisposition> {
  try {
    return (await getSetting(HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY)) === "true"
      ? "enabled"
      : "disabled";
  } catch {
    return "unavailable";
  }
}

/** Missing, malformed, or unreadable settings retain the legacy health snapshot writer. */
export async function isHealthSnapshotReceiptCutoverEnabled(): Promise<boolean> {
  return (await getHealthSnapshotReceiptCutoverDisposition()) === "enabled";
}

/** Client-injected form for reconciliation and real-libSQL compatibility tests. */
export async function isHealthSnapshotReceiptCutoverEnabledFor(
  client: HealthReceiptCutoverClient,
): Promise<boolean> {
  return (await getHealthSnapshotReceiptCutoverDispositionFor(client)) === "enabled";
}

/** Client-injected tri-state read used where a read failure must never choose the legacy writer. */
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
