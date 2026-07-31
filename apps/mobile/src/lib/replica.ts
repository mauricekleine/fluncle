// The device replica — the thin native layer over the five pure modules that decide
// everything about it (offline-first mobile, slice 2). One shared, read-only replica of the
// anchored public-catalogue cut, synced DIRECTLY from Turso with expo-sqlite's libSQL
// integration. The Worker's only part is minting the short-lived credential.
//
// THE LAW OF THIS SLICE: it is LAYERED, never load-bearing. Every link in the chain is
// allowed to be missing, and when one is the app behaves EXACTLY as it did before — the API
// path is the primary and stays it. Nothing here shows anyone an error, because none of these
// states is the reader's problem:
//
//   the token endpoint is dark      → the typed 503 latches, and the next foreground retries.
//   the build has no libSQL engine  → the first attempt learns it and the launch stays quiet.
//   the credential fails            → one re-fetch, then quiet.
//   the network is gone             → the pull fails; whatever was pulled before still reads.
//   nothing has ever been pulled    → there is no offline list, and the shipped offline state
//                                     stands exactly as it was written.
//
// AND THE COLD-OPEN RULE: nothing here runs before the app is interactive. `useReplicaSync`
// fires its bootstrap after the interactions settle; the pull that follows is background work
// the reader never waits on.
//
// The split, as everywhere else in this app: the decisions are pure and tested
// (./replica-identity, ./replica-token, ./replica-engine, ./replica-schedule, ./replica-rows),
// and this file is the I/O over them — the handle, the storage, the AppState wiring, and the
// shared cache the archive reads through.

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

// ── Launch state ─────────────────────────────────────────────────────────────────────────
// All module-level, all reset by the next launch. Nothing here is persisted except the token
// and the current filename: a verdict about THIS process (the engine, the dark latch) would
// be a lie the moment a new build installed.

let engineState: ReplicaEngineState = "unprobed";
let handle: SQLiteDatabase | undefined;
let openedName: string | undefined;
let cachedToken: CachedReplicaToken | undefined;
let tokenRestored = false;
let lastSyncedAt: number | undefined;
let syncPromise: Promise<void> | null = null;
/** Set when `get_replica_token` answers its typed 503. Lifted only by a foreground trigger. */
let darkLatched = false;
/** A stale file is rebuilt at most once per launch — see `staleRecovery`. */
let hasRebootstrapped = false;
/** True once a sync has verified this file's identity stamp. */
let replicaVerified = false;
/** Terminal for the launch: this file cannot be read by this build and rebuilding will not help. */
let replicaUnusable = false;

// The shared read cache, so the archive's offline branch never re-queries on a remount and
// two mounted hooks never disagree. `undefined` means "not read from disk yet".
let findingsCache: ReplicaFinding[] | undefined;
let findingsSettled = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────

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
  // Fire-and-forget: the in-memory copy is what this launch uses, and a failed write only
  // costs the next cold start one token fetch.
  void Storage.setItem(REPLICA_TOKEN_STORAGE_KEY, serializeCachedToken(token)).catch(
    () => undefined,
  );
}

/**
 * Record which file this device is using and delete the one it replaces. THE FILE IS KEYED TO
 * ITS REMOTE (see replica-identity.ts): re-pointing at a different database mints a different
 * filename, and without this the ~23 MB it replaces would sit on the device forever.
 */
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

// ── The credential ───────────────────────────────────────────────────────────────────────

/**
 * A usable credential, from the cache when it is still young enough and from the Worker
 * otherwise. Answers `undefined` for every failure — a dark endpoint, a network error, a
 * malformed body — and latches the dark flag only for the endpoint's own typed 503, which is
 * the one failure that retrying cannot fix.
 */
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
    // A forced mint is the credential RETRY: falling back to the cached copy would hand the
    // caller the very token that just failed, so it answers nothing and waits for the next
    // trigger. The cache is deliberately left standing either way — see below.
    if (options.force === true) {
      return undefined;
    }
    // A still-valid cached token beats nothing when the mint fails for a transient reason.
    return restored !== undefined && !isExpired(restored) ? restored : undefined;
  }
}

function isExpired(token: CachedReplicaToken): boolean {
  const expiresAt = Date.parse(token.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= Date.now();
}

// ── The handle ───────────────────────────────────────────────────────────────────────────

async function closeHandle(): Promise<void> {
  const open = handle;
  handle = undefined;
  openedName = undefined;
  replicaVerified = false;
  if (open) {
    await open.closeAsync().catch(() => undefined);
  }
}

/**
 * Open (or reuse) the handle for a credential's remote. Opening in libSQL mode needs a url and
 * a token even when the pull that follows is going to fail, which is exactly why an EXPIRED
 * cached token is still worth keeping: it is what lets a device that launches offline open the
 * cut it already downloaded.
 */
async function openFor(
  token: CachedReplicaToken,
  options: { reopen?: boolean } = {},
): Promise<SQLiteDatabase | undefined> {
  const name = replicaDatabaseName(token.url);
  // `reopen` exists for exactly one caller: the credential retry. A handle carries the token
  // it was OPENED with, so re-minting after an auth failure and then reusing the same handle
  // would retry with the very credential that just failed — a silent no-op dressed as a retry.
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

/** Read the file's identity stamp. A missing table reads as a missing row, not as an error. */
async function readMeta(db: SQLiteDatabase): Promise<ReplicaMetaRow | undefined> {
  try {
    return await db.getFirstAsync<ReplicaMetaRow>(
      'select "schema_version", "cut_name" from "device_sync_meta" limit 1',
    );
  } catch {
    return undefined;
  }
}

/**
 * Check the stamp, and act on a mismatch. Either branch DELETES the file — a replica this
 * build cannot read is not worth the megabytes — and the recovery decision (rebuild once, or
 * go quiet for the launch) is the pure `staleRecovery` rule.
 */
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

// ── The pull ─────────────────────────────────────────────────────────────────────────────

/**
 * One pull, end to end: credential → handle → `syncLibSQL()` → identity check. Every failure
 * returns quietly; the only thing a failure changes is the launch state the next attempt reads
 * (the engine verdict, the dark latch, a dropped credential).
 */
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
      // The build simply has no libSQL variant. Nothing was ever downloaded and nothing is
      // wrong; close the handle so the default-engine file is not left open.
      await closeHandle();
      return;
    }
    if (isAuthShapedSyncFailure(error)) {
      // The credential may have been revoked mid-lease. Mint one more and try ONCE — never a
      // loop: a second failure waits for the next trigger.
      //
      // The cached copy is NOT deleted. A dead credential is still what opens the local file
      // (opening does not validate it, only syncing does), so throwing it away would cost this
      // device the one thing the replica exists for: reading the cut it already has after
      // launching with no network. A successful mint overwrites it; nothing else needs to.
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
  // A fresh cut invalidates whatever the offline list is holding.
  findingsCache = undefined;
  findingsSettled = false;
  notify();
}

/**
 * Consider a pull. The gates, in the order a wasted call is cheapest to avoid: a terminal
 * verdict about this launch, then the dark latch, then freshness and single-flight.
 */
export function syncReplica(trigger: SyncTrigger): Promise<void> {
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

// ── The read ─────────────────────────────────────────────────────────────────────────────

/**
 * The findings the local cut holds, newest first — or an empty list for every dark state.
 *
 * This NEVER pulls. It is called when the device is offline, and its whole job is to serve
 * what a previous session already downloaded. On a cold start with no handle it opens the file
 * using the cached credential, expired or not, because opening does not validate it.
 */
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

  // A handle that has not been through a pull this launch has an unchecked stamp; a file
  // written by a build that reads a different cut must not reach the glass.
  //
  // The read CHECKS the stamp but never acts on a bad one — no delete, no latch, no spent
  // rebootstrap allowance. Discarding is the sync path's authority alone, because the read
  // runs offline: an empty file that a pull has simply not filled yet is indistinguishable
  // here from a genuinely stale one, and deleting on that guess would spend the one recovery
  // the next real pull is owed.
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
    // A missing table is what a never-bootstrapped file looks like. Nothing to serve.
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

/**
 * The offline list, as a hook. `ready` is what keeps the archive from flashing: it is true
 * only once this has an answer, so the offline branch shows its shipped state at the moment
 * the replica has been ruled out rather than a moment before.
 *
 * `enabled` is the archive's own condition (the feed is empty AND the device is offline), so a
 * connected reader never touches the file.
 */
export function useReplicaFindings(enabled: boolean): {
  findings: ReplicaFinding[];
  ready: boolean;
} {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    // A completed pull invalidates the cache and notifies. The listener re-arms the read as
    // well as re-rendering, because otherwise a sync that lands while this list is on screen
    // would clear the answer and nothing would ever fetch the new one — skeletons forever.
    // `ensureFindingsRead` is guarded, so the notification the read itself sends is a no-op.
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

// ── The schedule ─────────────────────────────────────────────────────────────────────────

/**
 * Wire the replica's whole schedule, once, from the root layout.
 *
 * The bootstrap waits on `runAfterInteractions` — the cold-open rule made mechanical: the
 * first pull is the biggest thing this app ever downloads and it may not share a frame with
 * first paint. After that the app's own rhythm drives it: a foreground transition (the moment
 * a fresh cut is worth most, and the only one that lifts the dark latch) and a quiet
 * in-session interval.
 */
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
