import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PUSH_PREFS,
  type PushCategory,
  type PushPrefs,
  deserialize,
  serialize,
} from "@/lib/push-prefs";

const STORAGE_KEY = "fluncle.push-prefs.v1";

export function useNotificationPrefs(): {
  prefs: PushPrefs;
  ready: boolean;
  setCategory: (category: PushCategory, enabled: boolean) => PushPrefs;
} {
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PUSH_PREFS);
  const [ready, setReady] = useState(false);

  const latest = useRef<PushPrefs>(DEFAULT_PUSH_PREFS);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(STORAGE_KEY)
      .catch(() => null)
      .then((raw) => {
        if (active) {
          const loaded = deserialize(raw);
          latest.current = loaded;
          setPrefs(loaded);
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const setCategory = useCallback((category: PushCategory, enabled: boolean): PushPrefs => {
    const next = { ...latest.current, [category]: enabled };
    latest.current = next;
    setPrefs(next);
    void AsyncStorage.setItem(STORAGE_KEY, serialize(next)).catch(() => undefined);
    return next;
  }, []);

  return { prefs, ready, setCategory };
}
