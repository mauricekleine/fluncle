import LegacyAsyncStorage from "@react-native-async-storage/async-storage";
import Storage from "expo-sqlite/kv-store";
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
import { readWithMigration } from "@/lib/storage-migration";

const STORAGE_KEY = "fluncle.saved.v1";

let cache: SavedFinding[] | null = null;
const listeners = new Set<(list: SavedFinding[]) => void>();

async function loadOnce(): Promise<SavedFinding[]> {
  if (cache !== null) {
    return cache;
  }

  const raw = await readWithMigration({
    key: STORAGE_KEY,
    kv: Storage,
    legacy: LegacyAsyncStorage,
  }).catch(() => null);
  cache = deserialize(raw);
  return cache;
}

function commit(next: SavedFinding[]): void {
  cache = next;
  for (const listener of listeners) {
    listener(next);
  }
  void Storage.setItem(STORAGE_KEY, serialize(next)).catch(() => undefined);
}

function hasSession(): boolean {
  const cookie = authClient.getCookie();
  return typeof cookie === "string" && cookie.trim().length > 0;
}

let mergePromise: Promise<void> | null = null;

let launchMergeAttempted = false;

export function mergeSavedWithAccount(): Promise<void> {
  if (mergePromise) {
    return mergePromise;
  }
  mergePromise = (async () => {
    const local = await loadOnce();
    const { merged } = await runUnionMerge({ fetch: meFetch, local });

    if (merged !== local) {
      commit(merged);
    }
  })().finally(() => {
    mergePromise = null;
  });
  return mergePromise;
}

function ensureLaunchMerge(): void {
  if (launchMergeAttempted) {
    return;
  }
  launchMergeAttempted = true;
  if (hasSession()) {
    void mergeSavedWithAccount();
  }
}

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

      ensureLaunchMerge();
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  const toggle = useCallback((finding: SavableFinding) => {
    const current = cache ?? [];

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
