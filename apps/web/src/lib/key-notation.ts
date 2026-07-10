// The admin's key-display preference: DJs mix harmonically by the Camelot wheel, so
// the operator can flip every admin key readout from musical scales ("F major") to
// Camelot notation ("7B") to line up a mixtape faster. A per-operator CLIENT pref —
// it lives in localStorage, no backend.
//
// useSyncExternalStore over module state (the same singleton shape as
// preview-player.ts) keeps this a plain store rather than a context threaded through
// the admin tree. SSR-safe: the server snapshot and the first client render both read
// the default ("scales"), and localStorage is only read once a component subscribes
// (post-mount), so there is no hydration mismatch.

import { useCallback, useSyncExternalStore } from "react";
import { keyToCamelotCode } from "./key-camelot";

export const KEY_NOTATIONS = ["scales", "camelot"] as const;
export type KeyNotation = (typeof KEY_NOTATIONS)[number];

const DEFAULT_NOTATION: KeyNotation = "scales";
const STORAGE_KEY = "fluncle.admin.key-notation";

// Pure display helper. `scales` returns the key verbatim; `camelot` maps a parsed
// "<note> <major|minor>" to its wheel code via the shared `key-camelot` core (the
// one place the pitch-class + wheel tables live). Anything that doesn't parse
// (unknown, empty, or an odd spelling) renders as-is — never throws, never blanks a
// real value.
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

function readStored(): KeyNotation {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "camelot" ? "camelot" : "scales";
  } catch {
    return DEFAULT_NOTATION;
  }
}

function subscribe(listener: () => void): () => void {
  // The first subscription (an effect, so post-mount) adopts the stored preference —
  // keeping the initial render on the default so hydration matches the server.
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
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // A private-mode / disabled-storage failure just keeps the pref in-memory.
  }
  emit(next);
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

  return { notation: current, setNotation: useCallback(setKeyNotation, []) };
}
