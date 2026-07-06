// The attention queue's snooze / won't-do store. A per-operator CLIENT pref, like
// the key-notation toggle: one operator, one browser, so a small localStorage map
// is the honest store — a server column could not see this browser's snoozes and
// would report a dishonest "due" count (docs/cockpit-roadmap.md, the queue
// mechanics; the store choice is deliberate and noted in the roadmap's terms).
//
// useSyncExternalStore over module state (the key-notation.ts singleton shape).
// SSR-safe: the server snapshot and the hydration render both read the EMPTY map,
// and the stored prefs are adopted on first subscription (post-mount), so there is
// no hydration mismatch — a snoozed row may paint for one frame, then settles.

import { useSyncExternalStore } from "react";
import { type QueuePrefs } from "./attention";

const STORAGE_KEY = "fluncle.admin.attention";
const EMPTY: QueuePrefs = {};

let prefs: QueuePrefs = EMPTY;
let hydrated = false;

const listeners = new Set<() => void>();

function emit(next: QueuePrefs): void {
  prefs = next;
  for (const listener of listeners) {
    listener();
  }
}

function readStored(): QueuePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return EMPTY;
    }
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as QueuePrefs) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function persist(next: QueuePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode / disabled storage keeps the prefs in-memory for the session.
  }
  emit(next);
}

function subscribe(listener: () => void): () => void {
  // The first subscription (an effect, post-mount) adopts the stored map, keeping
  // the initial render on the empty default so hydration matches the server.
  if (!hydrated) {
    hydrated = true;
    const stored = readStored();
    if (stored !== EMPTY) {
      emit(stored);
    }
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snooze a row until the given ISO time (replaces any prior decision). */
export function snoozeRow(id: string, untilIso: string): void {
  persist({ ...prefs, [id]: { snoozedUntil: untilIso } });
}

/** Dismiss a row permanently ("Won't do") — undoable via `restoreRow`. */
export function dismissRow(id: string, now: number = Date.now()): void {
  persist({ ...prefs, [id]: { wontDoAt: new Date(now).toISOString() } });
}

/** Clear a row's decision — the undo for both snooze and won't-do. */
export function restoreRow(id: string): void {
  const { [id]: _cleared, ...rest } = prefs;
  persist(rest);
}

/**
 * Drop decisions for rows that left the system (prune-on-read; keeps the map
 * bounded). A pruned singleton (drip-empty) re-arms honestly: a drip that
 * refills and empties AGAIN is a new episode, not the dismissed one.
 */
export function pruneQueuePrefs(liveIds: ReadonlySet<string>): void {
  const stale = Object.keys(prefs).filter((id) => !liveIds.has(id));
  if (stale.length === 0) {
    return;
  }
  const next = { ...prefs };
  for (const id of stale) {
    delete next[id];
  }
  persist(next);
}

/** The live prefs map (empty on the server and during hydration). */
export function useQueuePrefs(): QueuePrefs {
  return useSyncExternalStore(
    subscribe,
    () => prefs,
    () => EMPTY,
  );
}
