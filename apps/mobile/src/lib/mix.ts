import LegacyAsyncStorage from "@react-native-async-storage/async-storage";
import Storage from "expo-sqlite/kv-store";
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
import { readWithMigration } from "@/lib/storage-migration";

const STORAGE_KEY = "fluncle.mix.v1";

let cache: MixState | null = null;
const listeners = new Set<(state: MixState) => void>();

async function loadOnce(): Promise<MixState> {
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

function commit(next: MixState): void {
  cache = next;
  for (const listener of listeners) {
    listener(next);
  }
  void Storage.setItem(STORAGE_KEY, serialize(next)).catch(() => undefined);
}

export function useMixChain(): {
  add: (track: MixTrack) => void;
  adoptSourceSet: (reference: { id: string; name: string } | undefined) => void;
  chain: MixTrack[];
  clear: () => void;
  load: (chain: MixTrack[], taste: string[], sourceSetId?: string, sourceSetName?: string) => void;
  ready: boolean;
  remove: (token: string) => void;
  sourceSetId?: string;
  sourceSetName?: string;
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

  const load = useCallback(
    (chain: MixTrack[], taste: string[], sourceSetId?: string, sourceSetName?: string) =>
      commit({ chain, sourceSetId, sourceSetName, taste }),
    [],
  );

  const adoptSourceSet = useCallback((reference: { id: string; name: string } | undefined) => {
    const current = cache ?? EMPTY_MIX;
    commit({ ...current, sourceSetId: reference?.id, sourceSetName: reference?.name });
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
    sourceSetName: state.sourceSetName,
    taste: state.taste,
  };
}
