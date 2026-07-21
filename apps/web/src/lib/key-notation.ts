// Fluncle's ONE key-notation preference, consumed by EVERY key readout app-wide (the
// /log finding page, the /mix chain, the search filter echo, the admin chips): flip
// musical scales ("F major") to the Camelot notation ("7B") DJs mix harmonically by.
//
// DEVICE-LOCAL BY DEFAULT, PROFILE-SYNCED WHEN SIGNED IN. The choice lives in
// localStorage for everyone (an anonymous visitor uses it exactly as before — the
// account NEVER gates it). When a session is present, it ALSO rides on the user's
// profile (`/me/preferences`): the stored value is adopted on sign-in (the synced
// truth wins over the device), and every toggle is mirrored to the profile
// fire-and-forget so it follows the user across devices and surfaces.
//
// useSyncExternalStore over module state (the same singleton shape as
// preview-player.ts) keeps this a plain store rather than a context threaded through
// the tree. SSR-safe: the server snapshot and the first client render both read the
// default ("scales"); localStorage is read once a component subscribes (post-mount)
// and the profile value is fetched in an effect, so neither adoption touches the
// first render and there is no hydration mismatch.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { keyToCamelotCode } from "./key-camelot";

export const KEY_NOTATIONS = ["scales", "camelot"] as const;
export type KeyNotation = (typeof KEY_NOTATIONS)[number];

const DEFAULT_NOTATION: KeyNotation = "scales";
// The localStorage key is kept verbatim from when this was an admin-only preference,
// so a user's current choice survives this change — it is now the WHOLE app's
// notation, not the admin's, despite the historical `.admin.` segment in the name.
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

/** The current notation — a plain read of the store, for non-React callers and tests. */
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
  } catch {
    // A private-mode / disabled-storage failure just keeps the pref in-memory.
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
  // Optimistic + device-first: write localStorage and the store immediately, exactly
  // as the anonymous path always has. If a session is present, ALSO mirror the choice
  // to the profile fire-and-forget — a failed write never blocks or reverts the UI,
  // because the device value is still perfectly valid on its own.
  writeStored(next);
  emit(next);

  if (signedIn) {
    void pushPreferenceToAccount(next);
  }
}

// ── The account (profile-sync) layer ─────────────────────────────────────────
// Present ONLY when a session exists. It never touches the anonymous code path
// above: `signedIn` stays false for a stranger, so `setKeyNotation` behaves exactly
// as it did before this layer existed.

let signedIn = false;
let accountSyncStarted = false;

/** Coerce an untrusted profile value to a known notation, or `null` if it is neither. */
function asNotation(value: unknown): KeyNotation | null {
  return value === "scales" || value === "camelot" ? value : null;
}

/**
 * Mirror the chosen notation to the signed-in user's profile — a CSRF-guarded PATCH,
 * fire-and-forget. A lapsed session (csrf 401) or any network failure is swallowed:
 * the device value already holds, so a failed sync is never user-visible.
 */
async function pushPreferenceToAccount(next: KeyNotation): Promise<void> {
  try {
    const tokenResponse = await fetch("/api/v1/me/csrf");

    if (!tokenResponse.ok) {
      return;
    }

    const { csrfToken } = (await tokenResponse.json()) as { csrfToken?: string };

    await fetch("/api/v1/me/preferences", {
      body: JSON.stringify({ keyNotation: next }),
      headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken ?? "" },
      method: "PATCH",
    });
  } catch {
    // Fire-and-forget — the device value is the fallback, so there is nothing to do.
  }
}

/**
 * On a live session, adopt the PROFILE's stored notation into the store + localStorage
 * (the synced truth wins over the device on sign-in). Runs once per page load unless
 * `force`d — the account page forces a re-run after a sign-in mid-session so the
 * just-signed-in user's profile value is adopted without a reload. Anonymous or on
 * any failure: a no-op, leaving the device value untouched.
 */
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
  } catch {
    // Offline / unauthenticated / malformed — keep the device value; try again next load.
  }
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

  // Adopt the profile's notation once per page load when a session is present. The
  // module-level guard means many `useKeyNotation` consumers trigger at most one
  // fetch; it runs post-mount (an effect), so it never affects SSR or the first paint.
  useEffect(() => {
    void syncKeyNotationFromAccount();
  }, []);

  return { notation: current, setNotation: useCallback(setKeyNotation, []) };
}
