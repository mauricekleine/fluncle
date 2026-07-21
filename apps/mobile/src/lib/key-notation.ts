// The key-display preference — DJs mix harmonically by the Camelot wheel, so every key
// readout on the Mix tab can flip between musical scale text ("G# minor") and the wheel
// code ("1A"). The mobile twin of apps/web/src/lib/key-notation.ts, on the app's
// sanctioned device-store shape (module cache + listeners + AsyncStorage — see mix.ts).
//
// DEVICE-LOCAL BY DEFAULT, PROFILE-SYNCED WHEN SIGNED IN. The choice lives on this phone
// for everyone (an anonymous user uses it exactly as before — the account NEVER gates it,
// it only syncs). When a session is present, it ALSO rides on the user's profile
// (`/api/v1/me/preferences`): the stored value is adopted on sign-in (the synced truth wins
// over the device), and every toggle is mirrored to the profile fire-and-forget so it
// follows the user across devices and surfaces.
//
// The authenticated `/me` fetch is INJECTED (`configureKeyNotationSync`) rather than
// imported: `auth-client.ts` pulls native modules (expo-secure-store) that the repo's
// framework-free test harness can't load, so this module stays RN-shallow (AsyncStorage +
// a type-only MeFetch) and the account layer is unit-testable with a mocked fetch. The
// real `meFetch` is wired once at app startup (app/_layout.tsx).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { keyToCamelotCode } from "@/lib/key-camelot";
import { type MeFetch } from "@/lib/me-fetch";

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

/** The current notation — a plain read of the store, for non-React callers and tests. */
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

// The device write: update the cache, notify every mounted hook, and persist. The write is
// fire-and-forget — the in-memory value is the truth the UI reads, and a failed persist
// only means the change doesn't survive the next cold start. This is exactly the anonymous
// path, untouched; `setKeyNotation` layers the optional profile mirror on top.
function commit(next: KeyNotation): void {
  cache = next;
  for (const listener of listeners) {
    listener(next);
  }
  void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
}

/**
 * Set the notation. Device-first: write the store + AsyncStorage immediately, exactly as
 * the anonymous path always has. If a session is present, ALSO mirror the choice to the
 * profile fire-and-forget — a failed write never blocks or reverts the UI, because the
 * device value is still perfectly valid on its own.
 */
export function setKeyNotation(next: KeyNotation): void {
  commit(next);

  if (signedIn && meFetch) {
    void pushPreferenceToAccount(next);
  }
}

// ── The account (profile-sync) layer ─────────────────────────────────────────
// Present ONLY once a session is confirmed. It never touches the device path above:
// `signedIn` stays false for a stranger (and `meFetch` may be unwired), so `setKeyNotation`
// behaves exactly as it did before this layer existed.

let meFetch: MeFetch | null = null;
let signedIn = false;
let accountSyncStarted = false;

/**
 * Wire the authenticated `/me` fetch (built in auth-client.ts) into the account-sync layer.
 * Called once at app startup so the Mix-tab hook can adopt a returning user's profile value
 * without opening the account screen first. Until wired, the layer treats the user as
 * anonymous and every account path is a no-op.
 */
export function configureKeyNotationSync(fetcher: MeFetch): void {
  meFetch = fetcher;
}

/** Coerce an untrusted profile value to a known notation, or `null` if it is neither. */
function asNotation(value: unknown): KeyNotation | null {
  return value === "scales" || value === "camelot" ? value : null;
}

/**
 * Mirror the chosen notation to the signed-in user's profile — a CSRF-guarded PATCH through
 * `meFetch`, fire-and-forget. A lapsed session (csrf 401) or any network failure is
 * swallowed: the device value already holds, so a failed sync is never user-visible.
 */
async function pushPreferenceToAccount(next: KeyNotation): Promise<void> {
  if (!meFetch) {
    return;
  }

  try {
    await meFetch("/api/v1/me/preferences", {
      body: JSON.stringify({ keyNotation: next }),
      method: "PATCH",
    });
  } catch {
    // Fire-and-forget — the device value is the fallback, so there is nothing to do.
  }
}

/**
 * On a live session, adopt the PROFILE's stored notation into the store + AsyncStorage (the
 * synced truth wins over the device on sign-in). Runs once per app launch unless `force`d —
 * the account modal forces a re-run after a sign-in mid-session so the just-signed-in user's
 * profile value is adopted without a reload. Anonymous, unwired, or on any failure: a no-op,
 * leaving the device value untouched.
 */
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
  } catch {
    // Offline / unauthenticated / malformed — keep the device value; try again next launch.
  }
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

  // Adopt the profile's notation once per app launch when a session is present. The
  // module-level guard means many `useKeyNotation` consumers trigger at most one sync.
  useEffect(() => {
    void syncKeyNotationFromAccount();
  }, []);

  const setNotation = useCallback((next: KeyNotation) => setKeyNotation(next), []);

  return { notation, setNotation };
}
