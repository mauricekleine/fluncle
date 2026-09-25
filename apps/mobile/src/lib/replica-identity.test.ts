import {
  DEVICE_REPLICA_CUT,
  DEVICE_REPLICA_SCHEMA_VERSION,
  REPLICA_FILE_PREFIX,
  assessReplicaMeta,
  normalizeRemoteUrl,
  replicaDatabaseName,
  replicaKey,
  staleRecovery,
} from "@/lib/replica-identity";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(value: boolean, message: string): void {
  if (!value) {
    throw new Error(message);
  }
}

const REMOTE_A = "libsql://device-replica.example.turso.io";
const REMOTE_B = "libsql://device-replica-other.example.turso.io";

assertEqual(normalizeRemoteUrl(`  ${REMOTE_A}  `), REMOTE_A, "trims");
assertEqual(normalizeRemoteUrl(REMOTE_A.toUpperCase()), REMOTE_A, "lowercases");
assertEqual(normalizeRemoteUrl(`${REMOTE_A}///`), REMOTE_A, "drops trailing slashes");
assertEqual(normalizeRemoteUrl("not a url at all"), "not a url at all", "never throws");
assertEqual(normalizeRemoteUrl(""), "", "empty stays empty");

assertEqual(replicaKey(REMOTE_A), replicaKey(REMOTE_A), "same remote, same key");
assertEqual(replicaKey(REMOTE_A), replicaKey(` ${REMOTE_A.toUpperCase()}/`), "normalizes first");
assertTrue(replicaKey(REMOTE_A) !== replicaKey(REMOTE_B), "different remotes, different keys");
assertEqual(replicaKey(REMOTE_A).length, 16, "two 32-bit lanes, 16 hex chars");
assertTrue(/^[0-9a-f]{16}$/.test(replicaKey(REMOTE_A)), "lowercase hex only");

assertTrue(
  replicaKey("libsql://a.turso.io") !== replicaKey("libsql://b.turso.io"),
  "one-character difference separates",
);

assertEqual(replicaDatabaseName(REMOTE_A), `${REPLICA_FILE_PREFIX}${replicaKey(REMOTE_A)}.db`);
assertTrue(
  replicaDatabaseName(REMOTE_A) !== replicaDatabaseName(REMOTE_B),
  "a new remote never reuses the old file",
);

assertEqual(
  assessReplicaMeta({ cut_name: DEVICE_REPLICA_CUT, schema_version: DEVICE_REPLICA_SCHEMA_VERSION })
    .kind,
  "usable",
  "a matching stamp reads",
);

const missing = assessReplicaMeta(undefined);
assertEqual(missing.kind, "stale", "no row is stale");
assertEqual(missing.kind === "stale" ? missing.reason : "", "meta-missing");

const nulled = assessReplicaMeta(null);
assertEqual(nulled.kind === "stale" ? nulled.reason : "", "meta-missing", "a null row is missing");

const drifted = assessReplicaMeta({
  cut_name: DEVICE_REPLICA_CUT,
  schema_version: DEVICE_REPLICA_SCHEMA_VERSION + 1,
});
assertEqual(drifted.kind === "stale" ? drifted.reason : "", "schema-drift");

const stringVersion = assessReplicaMeta({
  cut_name: DEVICE_REPLICA_CUT,
  schema_version: String(DEVICE_REPLICA_SCHEMA_VERSION),
});
assertEqual(
  stringVersion.kind === "stale" ? stringVersion.reason : "",
  "schema-drift",
  "a version of the wrong TYPE is drift, never coerced",
);

const wrongCut = assessReplicaMeta({
  cut_name: "certified",
  schema_version: DEVICE_REPLICA_SCHEMA_VERSION,
});
assertEqual(wrongCut.kind === "stale" ? wrongCut.reason : "", "cut-drift");

assertEqual(staleRecovery("meta-missing", false), "rebootstrap", "first half-written file");
assertEqual(staleRecovery("meta-missing", true), "stay-dark", "never a bootstrap loop");
assertEqual(staleRecovery("schema-drift", false), "stay-dark", "rebuilding cannot fix drift");
assertEqual(staleRecovery("cut-drift", false), "stay-dark", "rebuilding cannot fix the cut");

console.log("replica-identity.test.ts: all assertions passed");
