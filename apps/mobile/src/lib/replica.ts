import { useEffect, useState } from "react";
import { AppState, InteractionManager } from "react-native";
import Storage from "expo-sqlite/kv-store";
import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { apiClient } from "@/api/orpc";
import {
  type ReplicaEngineState,
  engineAllowsAttempt,
  nextEngineState,
} from "@/lib/replica-engine";
import {
  type ReplicaMetaRow,
  REPLICA_DB_NAME_STORAGE_KEY,
  assessReplicaMeta,
  replicaDatabaseName,
  staleRecovery,
} from "@/lib/replica-identity";
import {
  type ReplicaFinding,
  type ReplicaFindingRow,
  REPLICA_FINDINGS_LIMIT,
  REPLICA_FINDINGS_SQL,
  toReplicaFindings,
} from "@/lib/replica-rows";
import {
  type SyncTrigger,
  REPLICA_SYNC_INTERVAL_MS,
  clearsDarkLatch,
  shouldSync,
} from "@/lib/replica-schedule";
import {
  type CachedReplicaToken,
  REPLICA_TOKEN_STORAGE_KEY,
  isAuthShapedSyncFailure,
  isReplicaUnavailableFault,
  parseCachedToken,
  serializeCachedToken,
  tokenNeedsRefresh,
} from "@/lib/replica-token";

export { type ReplicaFinding } from "@/lib/replica-rows";

let engineState: ReplicaEngineState = "unprobed";
let handle: SQLiteDatabase | undefined;
let openedName: string | undefined;
let cachedToken: CachedReplicaToken | undefined;
let tokenRestored = false;
let lastSyncedAt: number | undefined;
let syncPromise: Promise<void> | null = null;

let darkLatched = false;

let hasRebootstrapped = false;

let replicaVerified = false;

let replicaUnusable = false;

let findingsCache: ReplicaFinding[] | undefined;
let findingsSettled = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

async function restoreToken(): Promise<CachedReplicaToken | undefined> {
  if (tokenRestored) {
    return cachedToken;
  }
  tokenRestored = true;
  const raw = await Storage.getItem(REPLICA_TOKEN_STORAGE_KEY).catch(() => null);
  cachedToken = parseCachedToken(raw);
  return cachedToken;
}

function persistToken(token: CachedReplicaToken): void {
  cachedToken = token;

  void Storage.setItem(REPLICA_TOKEN_STORAGE_KEY, serializeCachedToken(token)).catch(
    () => undefined,
  );
}

async function rememberDatabaseName(name: string): Promise<void> {
  const previous = await Storage.getItem(REPLICA_DB_NAME_STORAGE_KEY).catch(() => null);
  if (previous === name) {
    return;
  }
  if (previous) {
    await deleteDatabaseAsync(previous).catch(() => undefined);
  }
  await Storage.setItem(REPLICA_DB_NAME_STORAGE_KEY, name).catch(() => undefined);
}

async function acquireToken(
  options: { force?: boolean } = {},
): Promise<CachedReplicaToken | undefined> {
  const restored = await restoreToken();
  if (options.force !== true && !tokenNeedsRefresh(restored, Date.now())) {
    return restored;
  }

  try {
    const minted = await apiClient.get_replica_token();
    const token: CachedReplicaToken = {
      expiresAt: minted.expiresAt,
      fetchedAt: Date.now(),
      token: minted.token,
      url: minted.url,
    };
    persistToken(token);
    return token;
  } catch (error) {
    if (isReplicaUnavailableFault(error)) {
      darkLatched = true;
    }

    if (options.force === true) {
      return undefined;
    }

    return restored !== undefined && !isExpired(restored) ? restored : undefined;
  }
}

function isExpired(token: CachedReplicaToken): boolean {
  const expiresAt = Date.parse(token.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= Date.now();
}

async function closeHandle(): Promise<void> {
  const open = handle;
  handle = undefined;
  openedName = undefined;
  replicaVerified = false;
  if (open) {
    await open.closeAsync().catch(() => undefined);
  }
}

async function openFor(
  token: CachedReplicaToken,
  options: { reopen?: boolean } = {},
): Promise<SQLiteDatabase | undefined> {
  const name = replicaDatabaseName(token.url);

  if (handle && openedName === name && options.reopen !== true) {
    return handle;
  }
  await closeHandle();
  await rememberDatabaseName(name);

  try {
    const opened = await openDatabaseAsync(name, {
      libSQLOptions: { authToken: token.token, url: token.url },
    });
    handle = opened;
    openedName = name;
    return opened;
  } catch {
    return undefined;
  }
}

async function readMeta(db: SQLiteDatabase): Promise<ReplicaMetaRow | undefined> {
  try {
    return await db.getFirstAsync<ReplicaMetaRow>(
      'select "schema_version", "cut_name" from "device_sync_meta" limit 1',
    );
  } catch {
    return undefined;
  }
}

async function verifyOrDiscard(db: SQLiteDatabase): Promise<boolean> {
  const verdict = assessReplicaMeta(await readMeta(db));
  if (verdict.kind === "usable") {
    replicaVerified = true;
    return true;
  }

  const recovery = staleRecovery(verdict.reason, hasRebootstrapped);
  const name = openedName;
  await closeHandle();
  if (name) {
    await deleteDatabaseAsync(name).catch(() => undefined);
  }

  if (recovery === "rebootstrap") {
    hasRebootstrapped = true;
    return false;
  }

  replicaUnusable = true;
  return false;
}

async function runSync(): Promise<void> {
  const token = await acquireToken();
  if (!token) {
    return;
  }

  const db = await openFor(token);
  if (!db) {
    return;
  }

  try {
    await db.syncLibSQL();
  } catch (error) {
    engineState = nextEngineState(engineState, { error, kind: "error" });
    if (engineState === "unsupported") {
      await closeHandle();
      return;
    }
    if (isAuthShapedSyncFailure(error)) {
      const replacement = await acquireToken({ force: true });
      if (!replacement) {
        return;
      }
      const reopened = await openFor(replacement, { reopen: true });
      if (!reopened) {
        return;
      }
      try {
        await reopened.syncLibSQL();
      } catch (retryError) {
        engineState = nextEngineState(engineState, { error: retryError, kind: "error" });
        return;
      }
      engineState = nextEngineState(engineState, { kind: "ok" });
      await finishSync(reopened);
      return;
    }
    return;
  }

  engineState = nextEngineState(engineState, { kind: "ok" });
  await finishSync(db);
}

async function finishSync(db: SQLiteDatabase): Promise<void> {
  const ok = await verifyOrDiscard(db);
  if (!ok) {
    return;
  }
  lastSyncedAt = Date.now();

  findingsCache = undefined;
  findingsSettled = false;
  notify();
}

function syncReplica(trigger: SyncTrigger): Promise<void> {
  if (clearsDarkLatch(trigger)) {
    darkLatched = false;
  }
  if (replicaUnusable || !engineAllowsAttempt(engineState) || darkLatched) {
    return Promise.resolve();
  }
  if (!shouldSync({ inFlight: syncPromise !== null, lastSyncedAt, now: Date.now() })) {
    return Promise.resolve();
  }

  syncPromise = runSync()
    .catch(() => undefined)
    .finally(() => {
      syncPromise = null;
    });
  return syncPromise;
}

async function readFindings(): Promise<ReplicaFinding[]> {
  if (replicaUnusable || !engineAllowsAttempt(engineState)) {
    return [];
  }

  let db = handle;
  if (!db) {
    const token = await restoreToken();
    if (!token) {
      return [];
    }
    db = await openFor(token);
    if (!db) {
      return [];
    }
  }

  if (!replicaVerified && assessReplicaMeta(await readMeta(db)).kind !== "usable") {
    return [];
  }

  try {
    const rows = await db.getAllAsync<ReplicaFindingRow>(
      REPLICA_FINDINGS_SQL,
      REPLICA_FINDINGS_LIMIT,
    );
    return toReplicaFindings(rows);
  } catch {
    return [];
  }
}

let readPromise: Promise<void> | null = null;

function ensureFindingsRead(): void {
  if (findingsSettled || readPromise !== null) {
    return;
  }
  readPromise = readFindings()
    .catch(() => [] as ReplicaFinding[])
    .then((findings) => {
      findingsCache = findings;
      findingsSettled = true;
      notify();
    })
    .finally(() => {
      readPromise = null;
    });
}

export function useReplicaFindings(enabled: boolean): {
  findings: ReplicaFinding[];
  ready: boolean;
} {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const listener = () => {
      ensureFindingsRead();
      forceRender((tick) => tick + 1);
    };
    listeners.add(listener);
    ensureFindingsRead();
    return () => {
      listeners.delete(listener);
    };
  }, [enabled]);

  if (!enabled) {
    return { findings: [], ready: false };
  }
  return { findings: findingsCache ?? [], ready: findingsSettled };
}

export function useReplicaSync(): void {
  useEffect(() => {
    const interactions = InteractionManager.runAfterInteractions(() => {
      void syncReplica("bootstrap");
    });

    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") {
        void syncReplica("foreground");
      }
    });

    const timer = setInterval(() => {
      void syncReplica("interval");
    }, REPLICA_SYNC_INTERVAL_MS);

    return () => {
      interactions.cancel();
      subscription.remove();
      clearInterval(timer);
    };
  }, []);
}
