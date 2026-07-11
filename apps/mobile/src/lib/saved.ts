// Device-local saved findings — the persistence + the React hook. The ungated
// variant (server-synced saves wait on the marginalia RFC and an account model). A
// save lives only on this phone: no network, no identity, survives restarts.
//
// Storage is `@react-native-async-storage/async-storage` (the sanctioned Expo choice;
// added because the app had no storage module). The pure toggle/keying/(de)serialize
// logic is ./saved-store.ts — this file is only the I/O and a shared in-memory cache
// so the detail modal's bookmark and the archive's Saved view stay in lockstep without
// a context provider.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import {
  type SavableFinding,
  type SavedFinding,
  deserialize,
  isSaved as isSavedInList,
  serialize,
  toggleSaved,
} from "@/lib/saved-store";

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
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  const toggle = useCallback((finding: SavableFinding) => {
    commit(toggleSaved(cache ?? [], finding, Date.now()));
  }, []);

  const isSaved = useCallback(
    (finding: Pick<SavableFinding, "logId" | "trackId">) => isSavedInList(list, finding),
    [list],
  );

  return { isSaved, list, ready, toggle };
}
