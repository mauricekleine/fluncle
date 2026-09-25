import { useCallback, useEffect, useSyncExternalStore } from "react";
import { csrfJsonHeaders, fetchCsrfToken } from "./authed-fetch";
import { keyToCamelotCode } from "./key-camelot";

const KEY_NOTATIONS = ["scales", "camelot"] as const;
export type KeyNotation = (typeof KEY_NOTATIONS)[number];

const DEFAULT_NOTATION: KeyNotation = "scales";

const STORAGE_KEY = "fluncle.admin.key-notation";

export function formatKey(key: string | undefined | null, notation: KeyNotation): string {
  if (!key) {
    return "";
  }
  if (notation === "scales") {
    return key;
  }

  return keyToCamelotCode(key) ?? key;
}

let notation: KeyNotation = DEFAULT_NOTATION;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(next: KeyNotation): void {
  notation = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getKeyNotation(): KeyNotation {
  return notation;
}

function readStored(): KeyNotation {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "camelot" ? "camelot" : "scales";
  } catch {
    return DEFAULT_NOTATION;
  }
}

function writeStored(next: KeyNotation): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {}
}

function subscribe(listener: () => void): () => void {
  if (!hydrated) {
    hydrated = true;
    const stored = readStored();
    if (stored !== notation) {
      emit(stored);
    }
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setKeyNotation(next: KeyNotation): void {
  writeStored(next);
  emit(next);

  if (signedIn) {
    void pushPreferenceToAccount(next);
  }
}

let signedIn = false;
let accountSyncStarted = false;

function asNotation(value: unknown): KeyNotation | null {
  return value === "scales" || value === "camelot" ? value : null;
}

async function pushPreferenceToAccount(next: KeyNotation): Promise<void> {
  try {
    const csrfToken = await fetchCsrfToken({ onLapsedSession: "ignore" });

    if (csrfToken === undefined) {
      return;
    }

    await fetch("/api/v1/me/preferences", {
      body: JSON.stringify({ keyNotation: next }),
      headers: csrfJsonHeaders(csrfToken),
      method: "PATCH",
    });
  } catch {}
}

export async function syncKeyNotationFromAccount(options?: { force?: boolean }): Promise<void> {
  if (accountSyncStarted && !options?.force) {
    return;
  }

  accountSyncStarted = true;

  try {
    const me = (await fetch("/api/v1/me").then((response) => response.json())) as {
      user?: unknown;
    };

    if (!me.user) {
      signedIn = false;
      return;
    }

    signedIn = true;

    const body = (await fetch("/api/v1/me/preferences").then((response) => response.json())) as {
      preferences?: { keyNotation?: unknown };
    };
    const profileNotation = asNotation(body.preferences?.keyNotation);

    if (profileNotation) {
      writeStored(profileNotation);

      if (profileNotation !== notation) {
        emit(profileNotation);
      }
    }
  } catch {}
}

export function useKeyNotation(): {
  notation: KeyNotation;
  setNotation: (next: KeyNotation) => void;
} {
  const current = useSyncExternalStore(
    subscribe,
    () => notation,
    () => DEFAULT_NOTATION,
  );

  useEffect(() => {
    void syncKeyNotationFromAccount();
  }, []);

  return { notation: current, setNotation: useCallback(setKeyNotation, []) };
}
