// Pure, React-Native-free logic for the account's saved `/mix` sets (RFC: accounts in the
// pocket, slice 5 — the accounts arc closes). Unlike saved findings, a saved SET has NO
// device-local store: the set-in-progress (mix-store.ts) is the phone's scratch chain, while
// a SAVED set lives only on the account. So there is no union-merge here — only a POST to
// save the current chain, a GET to list, a DELETE to remove, and the token→chain hydration
// that opens a saved set back into the Decks.
//
// THE ACCOUNT NEVER GATES THE TOOL. The Decks stay fully usable signed-out; these helpers
// only let a signed-in user keep a chain past the tab. This module owns the pure shapes so
// they can be unit-tested in the repo's framework-free harness (see saved-sets.test.ts) with
// `fetch` mocked — the wiring (meFetch, the store commit, navigation) lives in the screens.

import { type MixTrack } from "@fluncle/contracts";

/** The API path for the saved-sets endpoints (list/save/delete). */
export const SAVED_SETS_PATH = "/api/me/saved-sets";

/**
 * One saved set as `list_private_saved_sets` returns it (GET /api/me/saved-sets). `setTokens`
 * is the serialized `?set=` chain and `taste` the serialized `?taste=` seed — echoed VERBATIM,
 * so opening a set is a matter of handing them back to the builder's parse helpers. `taste` is
 * absent when the chain carried no seed.
 */
export type RemoteSavedSet = {
  createdAt: string;
  id: string;
  name: string;
  setTokens: string;
  taste?: string;
  updatedAt: string;
};

/**
 * The save-set request body — the reader's `name` plus the serialized `?set=` chain and its
 * `?taste=` seed, keyed EXACTLY as the web posts them (`{ name, set, taste }`), so the one
 * server helper parses both surfaces the same way. The name is trimmed; a blank one still rides
 * (the server derives one from the first track + date). Taste rides even when empty (the
 * server's `parseTasteParam("")` yields no seed), mirroring the web byte-for-byte.
 */
export function buildSaveSetBody(
  name: string,
  serializedSet: string,
  serializedTaste: string,
): { name: string; set: string; taste: string } {
  return { name: name.trim(), set: serializedSet, taste: serializedTaste };
}

/**
 * Tolerantly read the account list body (`{ ok, savedSets }`) into rows, dropping anything that
 * does not carry the fields a row renders + opens from. Never throws — a shape surprise yields
 * [] (mirrors saved-sync.ts's `parseRemoteList`).
 */
export function parseRemoteSetsList(body: unknown): RemoteSavedSet[] {
  if (typeof body !== "object" || body === null) {
    return [];
  }

  const envelope = body as { savedSets?: unknown };
  if (!Array.isArray(envelope.savedSets)) {
    return [];
  }

  return envelope.savedSets.filter(isRemoteSavedSet);
}

function isRemoteSavedSet(value: unknown): value is RemoteSavedSet {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.setTokens === "string" &&
    typeof row.createdAt === "string" &&
    typeof row.updatedAt === "string" &&
    (row.taste === undefined || typeof row.taste === "string")
  );
}

/**
 * Hydrate a whole saved set from its serialized `?set=` token string in ONE read, via the
 * injected `fetchSet` (the public `list_set_tracks` op — GET /mix/set-tracks). That op is the
 * server twin of the web `/mix` loader's `getMixTracksByTokens`: it parses the token grammar
 * (Log IDs + Spotify ids mixed), resolves BOTH certified findings and uncertified catalogue
 * tracks, preserves order, collapses duplicates, caps at 32, and omits any token it cannot
 * resolve. So this wrapper only guards the edges the op does not see — an empty seed short-
 * circuits with no round trip, and a network/parse fault degrades to an empty chain rather than
 * blanking the tab. The rows come back as `MixTrack` already; there is nothing to adapt.
 *
 * This replaces the old per-token `get_track` walk, which resolved ONLY certified findings and
 * silently dropped every uncertified token — the exact tokens the Decks rail serves.
 */
export async function resolveSavedSet(
  serializedSet: string,
  fetchSet: (set: string) => Promise<MixTrack[]>,
): Promise<MixTrack[]> {
  if (!serializedSet.trim()) {
    return [];
  }

  try {
    return await fetchSet(serializedSet);
  } catch {
    return [];
  }
}
