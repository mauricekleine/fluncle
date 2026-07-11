// The push category preferences — persistence + the React hook. Which categories the
// crew wants on this device, stored locally and read back on mount. The pure mapping
// to the contract's `mutedCategories` array is ./push-prefs.ts; this file is only the
// AsyncStorage I/O and the hook the notifications screen drives.
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

/** The push prefs as a hook: the current toggles, a readiness flag (so the screen can
 * hold the switches until the disk read lands), and a setter that persists and returns
 * the NEXT prefs so the caller can re-register the device with the fresh muted set. */
export function useNotificationPrefs(): {
  prefs: PushPrefs;
  ready: boolean;
  setCategory: (category: PushCategory, enabled: boolean) => PushPrefs;
} {
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PUSH_PREFS);
  const [ready, setReady] = useState(false);
  // The latest prefs, readable synchronously inside setCategory (so a fast double-tap
  // composes off the newest value, not a stale render's closure).
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
