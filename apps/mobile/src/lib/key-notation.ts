import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { keyToCamelotCode } from "@/lib/key-camelot";
import { type MeFetch } from "@/lib/me-fetch";

export type KeyNotation = "camelot" | "scales";

const DEFAULT_NOTATION: KeyNotation = "scales";
const STORAGE_KEY = "fluncle.key-notation.v1";

export function formatKey(key: string | undefined | null, notation: KeyNotation): string {
  if (!key) {
    return "";
  }
  if (notation === "scales") {
    return key;
  }

  return keyToCamelotCode(key) ?? key;
}

let cache: KeyNotation | null = null;
const listeners = new Set<(notation: KeyNotation) => void>();

export function getKeyNotation(): KeyNotation {
  return cache ?? DEFAULT_NOTATION;
}

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

export function setKeyNotation(next: KeyNotation): void {
  commit(next);

  if (signedIn && meFetch) {
    void pushPreferenceToAccount(next);
  }
}

let meFetch: MeFetch | null = null;
let signedIn = false;
let accountSyncStarted = false;

export function configureKeyNotationSync(fetcher: MeFetch): void {
  meFetch = fetcher;
}

function asNotation(value: unknown): KeyNotation | null {
  return value === "scales" || value === "camelot" ? value : null;
}

async function pushPreferenceToAccount(next: KeyNotation): Promise<void> {
  if (!meFetch) {
    return;
  }

  try {
    await meFetch("/api/v1/me/preferences", {
      body: JSON.stringify({ keyNotation: next }),
      method: "PATCH",
    });
  } catch {}
}

export async function syncKeyNotationFromAccount(options?: { force?: boolean }): Promise<void> {
  if (!meFetch) {
    return;
  }
  if (accountSyncStarted && !options?.force) {
    return;
  }

  accountSyncStarted = true;

  try {
    const me = (await meFetch("/api/v1/me").then((response) => response.json())) as {
      user?: unknown;
    };

    if (!me.user) {
      signedIn = false;
      return;
    }

    signedIn = true;

    const body = (await meFetch("/api/v1/me/preferences").then((response) => response.json())) as {
      preferences?: { keyNotation?: unknown };
    };
    const profileNotation = asNotation(body.preferences?.keyNotation);

    if (profileNotation && profileNotation !== cache) {
      commit(profileNotation);
    }
  } catch {}
}

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

  useEffect(() => {
    void syncKeyNotationFromAccount();
  }, []);

  const setNotation = useCallback((next: KeyNotation) => setKeyNotation(next), []);

  return { notation, setNotation };
}
