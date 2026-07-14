// The device-local set-in-progress — the persistence + the React hook. A save lives only on
// this phone: no network, no identity, survives restarts. The pure add/remove/cap/(de)-
// serialize logic is ./mix-store.ts; this file is only the I/O and a shared in-memory cache
// so every mounted instance of the Mix screen stays in lockstep without a context provider.
//
// Mirrors ./saved.ts exactly (the sanctioned AsyncStorage pattern) — one store, one
// disk-read, fire-and-forget writes, an in-memory truth the UI reads.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { type MixTrack } from "@fluncle/contracts";
import {
  type MixState,
  addTrack,
  deserialize,
  EMPTY_MIX,
  removeTrack,
  serialize,
} from "@/lib/mix-store";

const STORAGE_KEY = "fluncle.mix.v1";

// One shared source of truth across every mounted hook. `cache === null` means the store
// hasn't been read from disk yet.
let cache: MixState | null = null;
const listeners = new Set<(state: MixState) => void>();

async function loadOnce(): Promise<MixState> {
  if (cache !== null) {
    return cache;
  }

  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  cache = deserialize(raw);

  return cache;
}

// Commit a new set: update the cache, notify every mounted hook, and persist. The write is
// fire-and-forget — the in-memory set is the truth the UI reads, and a failed write only
// means the change doesn't survive the next cold start.
function commit(next: MixState): void {
  cache = next;
  for (const listener of listeners) {
    listener(next);
  }
  void AsyncStorage.setItem(STORAGE_KEY, serialize(next)).catch(() => undefined);
}

/**
 * The set-in-progress as a hook: the current chain + taste, a readiness flag (so the screen
 * never flashes the empty picker before the disk read), and the mutations the builder needs.
 * Every mounted instance shares one set.
 *
 * NOTE ON THE WEB'S GATE: the web `/mix` route is guarded by a self-lifting archive-depth
 * check (a stranger is sent home until the median track can reach a set's worth of neighbours
 * by a named harmonic move). The app does not check it — the tool must be reachable for App
 * Review, the three mix ops are public and open in prod, and a quiet rail already reads as
 * "quiet sector tonight" rather than a broken tool. So the tab is always live here.
 */
export function useMixChain(): {
  add: (track: MixTrack) => void;
  adoptSourceSet: (sourceSetId: string | undefined) => void;
  chain: MixTrack[];
  clear: () => void;
  load: (chain: MixTrack[], taste: string[], sourceSetId?: string) => void;
  ready: boolean;
  remove: (token: string) => void;
  sourceSetId?: string;
  setTaste: (taste: string[]) => void;
  taste: string[];
} {
  const [state, setState] = useState<MixState>(cache ?? EMPTY_MIX);
  const [ready, setReady] = useState<boolean>(cache !== null);

  useEffect(() => {
    let active = true;
    const listener = (next: MixState) => setState(next);
    listeners.add(listener);
    void loadOnce().then((loaded) => {
      if (active) {
        setState(loaded);
        setReady(true);
      }
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  const add = useCallback((track: MixTrack) => {
    const current = cache ?? EMPTY_MIX;
    commit({ ...current, chain: addTrack(current.chain, track) });
  }, []);

  const remove = useCallback((token: string) => {
    const current = cache ?? EMPTY_MIX;
    commit({ ...current, chain: removeTrack(current.chain, token) });
  }, []);

  const setTaste = useCallback((taste: string[]) => {
    const current = cache ?? EMPTY_MIX;
    commit({ ...current, taste });
  }, []);

  const clear = useCallback(() => commit(EMPTY_MIX), []);

  // Replace the whole set at once — the open-a-saved-set path (account.tsx hands the resolved
  // chain + taste in). Unlike add/remove this overwrites both fields, so opening a saved set
  // lands the reader in that set rather than appending to whatever scratch chain they had.
  const load = useCallback(
    (chain: MixTrack[], taste: string[], sourceSetId?: string) =>
      commit({ chain, sourceSetId, taste }),
    [],
  );

  // Adopt the account set this chain now belongs to (after a fresh save creates one),
  // so every later "Save set" updates that set instead of minting siblings.
  const adoptSourceSet = useCallback((sourceSetId: string | undefined) => {
    const current = cache ?? EMPTY_MIX;
    commit({ ...current, sourceSetId });
  }, []);

  return {
    add,
    adoptSourceSet,
    chain: state.chain,
    clear,
    load,
    ready,
    remove,
    setTaste,
    sourceSetId: state.sourceSetId,
    taste: state.taste,
  };
}
