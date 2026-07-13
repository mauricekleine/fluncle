// The key-display preference — DJs mix harmonically by the Camelot wheel, so every key
// readout on the Mix tab can flip between musical scale text ("G# minor") and the wheel
// code ("1A"). The mobile twin of apps/web/src/lib/key-notation.ts, on the app's
// sanctioned device-store shape (module cache + listeners + AsyncStorage — see mix.ts):
// a display pref lives on this phone, no network, no identity.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { keyToCamelotCode } from "@/lib/key-camelot";

export type KeyNotation = "camelot" | "scales";

const DEFAULT_NOTATION: KeyNotation = "scales";
const STORAGE_KEY = "fluncle.key-notation.v1";

/**
 * Pure display helper (mirrors the web's `formatKey`). `scales` returns the key verbatim;
 * `camelot` maps a parsed "<note> <major|minor>" to its wheel code. Anything that doesn't
 * parse renders as-is — never throws, never blanks a real value.
 */
export function formatKey(key: string | undefined | null, notation: KeyNotation): string {
  if (!key) {
    return "";
  }
  if (notation === "scales") {
    return key;
  }

  return keyToCamelotCode(key) ?? key;
}

// One shared source of truth across every mounted hook; the first subscriber adopts the
// stored preference (the default renders until the disk read lands — a display pref, so
// a one-frame default is invisible in practice).
let cache: KeyNotation | null = null;
const listeners = new Set<(notation: KeyNotation) => void>();

async function loadOnce(): Promise<KeyNotation> {
  if (cache !== null) {
    return cache;
  }

  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  cache = raw === "camelot" ? "camelot" : DEFAULT_NOTATION;

  return cache;
}

function commit(next: KeyNotation): void {
  cache = next;
  for (const listener of listeners) {
    listener(next);
  }
  void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
}

/** The notation preference as a hook; every mounted instance shares one value. */
export function useKeyNotation(): {
  notation: KeyNotation;
  setNotation: (notation: KeyNotation) => void;
} {
  const [notation, setNotationState] = useState<KeyNotation>(cache ?? DEFAULT_NOTATION);

  useEffect(() => {
    let active = true;
    const listener = (next: KeyNotation) => setNotationState(next);
    listeners.add(listener);
    void loadOnce().then((loaded) => {
      if (active) {
        setNotationState(loaded);
      }
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  const setNotation = useCallback((next: KeyNotation) => commit(next), []);

  return { notation, setNotation };
}
