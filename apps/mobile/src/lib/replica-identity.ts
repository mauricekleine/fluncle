// WHICH replica file this build is allowed to read — the pure half of the device replica's
// identity rules (offline-first mobile, slice 2). Framework-free and native-free: no
// expo-sqlite import, no RN tree, so every rule below is pinned by a test.
//
// Two rules live here, and both exist because of a failure the spike walked into.
//
// 1. THE FILE IS KEYED TO ITS REMOTE. The local database's FILENAME is derived from a hash
//    of the remote URL, so pointing the app at a different Turso database can never reuse
//    the old file. A replica carries the remote's generation state inside it; opened
//    against a DIFFERENT remote it half-works — reads answer from stale rows, then a sync
//    fails with a generation error. Keying the name to the URL means that state cannot
//    exist: a new remote is a new file, and the old one is deleted by name (the wiring
//    remembers the previous name — see ./replica.ts).
//
// 2. THE FILE MUST SAY WHAT IT IS. The derived database carries one `device_sync_meta` row
//    stamped with the schema version and the cut name it was built from. A file whose
//    stamp does not match what this build reads is not repaired and not rendered from — it
//    is deleted, and the app falls back to its API path. `assessReplicaMeta` is that check
//    and `staleRecovery` decides whether deleting it is worth a second bootstrap.
//
// The two expected values are DUPLICATED from the deriving side
// (apps/web/scripts/lib/device-db-schema.ts — `DEVICE_DB_SCHEMA_VERSION` and the `anchored`
// cut) rather than imported: the mobile app does not depend on the web app's scripts. That
// duplication is exactly why the check exists — a drift between the two sides makes the
// replica dark rather than wrong.

/** The `device_sync_meta.schema_version` this build knows how to read. */
export const DEVICE_REPLICA_SCHEMA_VERSION = 1;

/** The `device_sync_meta.cut_name` this build expects — the anchored public-catalogue cut. */
export const DEVICE_REPLICA_CUT = "anchored";

/** The filename stem every replica file shares, so a keyed name is recognisable on sight. */
export const REPLICA_FILE_PREFIX = "fluncle-replica-";

/** The kv-store key holding the filename currently in use, so a re-key can delete the old file. */
export const REPLICA_DB_NAME_STORAGE_KEY = "fluncle.replica.db-name.v1";

/**
 * Fold a remote URL down to the form the key is taken over. Total by construction — it never
 * parses and never throws, because a URL this cannot read must still produce a stable key
 * (an unreadable URL is a dark replica, not a crash).
 */
export function normalizeRemoteUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

// FNV-1a over 32 bits with `Math.imul` for the wrap — deterministic, dependency-free, and
// no BigInt (which would tie the key to a Hermes capability it does not need).
function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A 64-bit hex key for a remote URL, as two independently-seeded 32-bit lanes. One lane
 * would collide often enough to matter over the lifetime of an app that must never open a
 * replica against the wrong remote; two make the collision that would resurrect the bug
 * vanishingly unlikely while staying plain integer arithmetic.
 */
export function replicaKey(remoteUrl: string): string {
  const normalized = normalizeRemoteUrl(remoteUrl);
  const low = fnv1a32(normalized, 0x811c9dc5);
  const high = fnv1a32(`${normalized}#lane1`, 0x01000193);
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

/** The local database FILENAME for a remote. The same remote always answers the same name. */
export function replicaDatabaseName(remoteUrl: string): string {
  return `${REPLICA_FILE_PREFIX}${replicaKey(remoteUrl)}.db`;
}

/** The `device_sync_meta` row as SQLite hands it back — every field unknown until checked. */
export type ReplicaMetaRow = {
  cut_name?: unknown;
  schema_version?: unknown;
} | null;

/** Why a local replica file cannot be read by this build. */
export type ReplicaStaleReason = "meta-missing" | "schema-drift" | "cut-drift";

/** The verdict on a local replica file: readable, or stale with the reason it is stale. */
export type ReplicaVerdict = { kind: "usable" } | { kind: "stale"; reason: ReplicaStaleReason };

/**
 * Is this file's identity stamp one this build can read?
 *
 * A missing row is `meta-missing` rather than an error: it is what a half-bootstrapped file
 * looks like, and that one IS worth a second attempt. A stamp that is present and disagrees
 * is deterministic — the remote is simply not what this build reads — so it never retries.
 */
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

/** What to do with a stale file. Either way the file is deleted; this decides what follows. */
export type StaleRecovery = "rebootstrap" | "stay-dark";

/**
 * A half-written file is worth exactly ONE more bootstrap; a stamp mismatch is worth none,
 * because bootstrapping again would only rebuild the same unreadable shape. The
 * already-tried flag is what keeps a wedged remote from turning into a bootstrap loop that
 * re-downloads the cut on every foreground.
 */
export function staleRecovery(
  reason: ReplicaStaleReason,
  hasRebootstrapped: boolean,
): StaleRecovery {
  return reason === "meta-missing" && !hasRebootstrapped ? "rebootstrap" : "stay-dark";
}
