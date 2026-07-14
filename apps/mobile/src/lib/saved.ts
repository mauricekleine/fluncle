// Device-local saved findings — the persistence + the React hook. A save lives on this
// phone: no identity required, survives restarts. When a session IS present the saves
// also RIDE THE ACCOUNT (RFC: accounts in the pocket, slice 4): a union-merge once per
// sign-in, then each local action mirrors up fire-and-forget. THE LAW: the device store
// stays the render source and anonymous saves are untouched — the account only SYNCS.
//
// Storage is `@react-native-async-storage/async-storage` (the sanctioned Expo choice;
// added because the app had no storage module). The pure toggle/keying/(de)serialize
// logic is ./saved-store.ts and the pure sync loop is ./saved-sync.ts — this file is only
// the I/O, a shared in-memory cache (so the detail modal's bookmark and the archive's
// Saved view stay in lockstep without a context provider), and the account wiring.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { authClient, meFetch } from "@/lib/auth-client";
import {
  type SavableFinding,
  type SavedFinding,
  deserialize,
  isSaved as isSavedInList,
  serialize,
  toggleSaved,
} from "@/lib/saved-store";
import { deleteSavedFinding, pushSavedFinding, runUnionMerge } from "@/lib/saved-sync";

const STORAGE_KEY = "fluncle.saved.v1";

// One shared source of truth across every mounted hook. `cache === null` means the
// store hasn't been read from disk yet.
let cache: SavedFinding[] | null = null;
const listeners = new Set<(list: SavedFinding[]) => void>();

async function loadOnce(): Promise<SavedFinding[]> {
  if (cache !== null) {
    return cache;
  }
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  cache = deserialize(raw);
  return cache;
}

// Commit a new list: update the cache, notify every mounted hook, and persist. The
// write is fire-and-forget — the in-memory list is the truth the UI reads, and a
// failed write only means the change doesn't survive the next cold start.
function commit(next: SavedFinding[]): void {
  cache = next;
  for (const listener of listeners) {
    listener(next);
  }
  void AsyncStorage.setItem(STORAGE_KEY, serialize(next)).catch(() => undefined);
}

// --- Account sync (RFC: accounts in the pocket, slice 4) -------------------------------
// The account is synced only when signed in; the device store is always the render truth.

// True ⇔ a session cookie is on hand. The account calls below are no-ops without one, so
// anonymous saves take not a single network hop (the untouched-anonymous law).
function hasSession(): boolean {
  const cookie = authClient.getCookie();
  return typeof cookie === "string" && cookie.trim().length > 0;
}

// The union-merge coalesces on one in-flight promise so overlapping triggers (a cold-start
// launch that races a sign-in) do the work once.
let mergePromise: Promise<void> | null = null;
// The cold-start launch check runs at most once per app session (the key-notation loadOnce
// idiom); an in-session sign-in triggers its own merge via mergeSavedWithAccount().
let launchMergeAttempted = false;

/**
 * Union-merge the device saves into the signed-in account, then write the union back to the
 * device store. Pushes every device-only save up (the idempotent-POST loop), pulls the account
 * list, and commits the union — the device store stays the render source. A failed pull (no
 * session, offline, an error) leaves the store untouched; it never clobbers local saves. Safe
 * to call repeatedly — overlapping calls share one in-flight run.
 */
export function mergeSavedWithAccount(): Promise<void> {
  if (mergePromise) {
    return mergePromise;
  }
  mergePromise = (async () => {
    const local = await loadOnce();
    const { merged } = await runUnionMerge({ fetch: meFetch, local });
    // runUnionMerge returns the SAME `local` reference on a failed pull; a new array only on a
    // real merge — so identity tells us whether there is anything to write back.
    if (merged !== local) {
      commit(merged);
    }
  })().finally(() => {
    mergePromise = null;
  });
  return mergePromise;
}

// On a cold start that is ALREADY signed in, run the union-merge once. Sign-in itself calls
// mergeSavedWithAccount() from the account modal, so this only covers the already-aboard case.
function ensureLaunchMerge(): void {
  if (launchMergeAttempted) {
    return;
  }
  launchMergeAttempted = true;
  if (hasSession()) {
    void mergeSavedWithAccount();
  }
}

// Mirror a local save/unsave to the account, fire-and-forget: only when signed in, and a
// failure never blocks or reverts the local action (offline-first — the device store already
// stands). Sync points are sign-in + each local action; there is no periodic re-pull.
function mirrorAction(finding: SavableFinding, saved: boolean): void {
  if (!hasSession()) {
    return;
  }
  if (saved) {
    void pushSavedFinding(meFetch, finding);
  } else {
    void deleteSavedFinding(meFetch, finding.trackId);
  }
}

/** The saved-findings store as a hook: the current list, a readiness flag (so the
 * Saved view never flashes empty before the disk read), a saved-state check, and a
 * toggle. Every mounted instance shares one list. */
export function useSavedFindings(): {
  isSaved: (finding: Pick<SavableFinding, "logId" | "trackId">) => boolean;
  list: SavedFinding[];
  ready: boolean;
  toggle: (finding: SavableFinding) => void;
} {
  const [list, setList] = useState<SavedFinding[]>(cache ?? []);
  const [ready, setReady] = useState<boolean>(cache !== null);

  useEffect(() => {
    let active = true;
    const listener = (next: SavedFinding[]) => setList(next);
    listeners.add(listener);
    void loadOnce().then((loaded) => {
      if (active) {
        setList(loaded);
        setReady(true);
      }
      // Once the store is on hand, cold-start the account union-merge if already signed in
      // (module-guarded to run once per app session).
      ensureLaunchMerge();
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  const toggle = useCallback((finding: SavableFinding) => {
    const current = cache ?? [];
    // The flip is device-local and immediate; mirror the RESULTING state to the account
    // fire-and-forget (a save POSTs, an unsave DELETEs) when signed in.
    const nowSaved = !isSavedInList(current, finding);
    commit(toggleSaved(current, finding, Date.now()));
    mirrorAction(finding, nowSaved);
  }, []);

  const isSaved = useCallback(
    (finding: Pick<SavableFinding, "logId" | "trackId">) => isSavedInList(list, finding),
    [list],
  );

  return { isSaved, list, ready, toggle };
}
