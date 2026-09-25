import { fnv1a32 } from "@fluncle/contracts/util/hash";

export const DEVICE_REPLICA_SCHEMA_VERSION = 1;

export const DEVICE_REPLICA_CUT = "anchored";

export const REPLICA_FILE_PREFIX = "fluncle-replica-";

export const REPLICA_DB_NAME_STORAGE_KEY = "fluncle.replica.db-name.v1";

export function normalizeRemoteUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

export function replicaKey(remoteUrl: string): string {
  const normalized = normalizeRemoteUrl(remoteUrl);
  const low = fnv1a32(normalized, 0x811c9dc5);
  const high = fnv1a32(`${normalized}#lane1`, 0x01000193);
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

export function replicaDatabaseName(remoteUrl: string): string {
  return `${REPLICA_FILE_PREFIX}${replicaKey(remoteUrl)}.db`;
}

export type ReplicaMetaRow = {
  cut_name?: unknown;
  schema_version?: unknown;
} | null;

export type ReplicaStaleReason = "meta-missing" | "schema-drift" | "cut-drift";

export type ReplicaVerdict = { kind: "usable" } | { kind: "stale"; reason: ReplicaStaleReason };

export function assessReplicaMeta(row: ReplicaMetaRow | undefined): ReplicaVerdict {
  if (!row) {
    return { kind: "stale", reason: "meta-missing" };
  }

  const version = row.schema_version;
  if (typeof version !== "number" || version !== DEVICE_REPLICA_SCHEMA_VERSION) {
    return { kind: "stale", reason: "schema-drift" };
  }

  if (row.cut_name !== DEVICE_REPLICA_CUT) {
    return { kind: "stale", reason: "cut-drift" };
  }

  return { kind: "usable" };
}

export type StaleRecovery = "rebootstrap" | "stay-dark";

export function staleRecovery(
  reason: ReplicaStaleReason,
  hasRebootstrapped: boolean,
): StaleRecovery {
  return reason === "meta-missing" && !hasRebootstrapped ? "rebootstrap" : "stay-dark";
}
