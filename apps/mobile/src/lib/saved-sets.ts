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
import { setToken } from "@/lib/mix-set";

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
 * The save-set POST body — the serialized `?set=` chain plus its `?taste=` seed, keyed EXACTLY
 * as the web ShareSetButton posts them (`{ set, taste }`), so the one server helper parses both
 * surfaces the same way. No `name`: a blank name lets the server derive one from the first
 * track + date (renaming lives on the web /account page). Taste rides even when empty (the
 * server's `parseTasteParam("")` yields no seed), mirroring the web byte-for-byte.
 */
export function buildSaveSetBody(
  serializedSet: string,
  serializedTaste: string,
): { set: string; taste: string } {
  return { set: serializedSet, taste: serializedTaste };
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
 * Adapt a `get_track` finding into a chain row. A `get_track` "track" result is always a
 * CERTIFIED finding (it resolved a log-page target), so `certified` is true and the coordinate
 * rides as `logId` — the same shape `searchHitToMixTrack` builds for the opener search. Typed
 * as a Pick of just the fields a row needs, so the adapter stays decoupled + unit-testable.
 */
export function adaptTrackToMixTrack(item: {
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  durationMs: number;
  key?: string;
  logId?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
}): MixTrack {
  return {
    albumImageUrl: item.albumImageUrl,
    artists: item.artists,
    bpm: item.bpm,
    certified: true,
    durationMs: item.durationMs,
    key: item.key,
    logId: item.logId,
    spotifyUrl: item.spotifyUrl,
    title: item.title,
    trackId: item.trackId,
  };
}

/**
 * Resolve an ordered token list into chain rows, walking the tokens in order (a set is a
 * sequence — mirrors the web's `getMixTracksByTokens`, which orders by the tokens, not the
 * rows). Each token is resolved through the injected `fetchToken`; a token that resolves to
 * `null` (an uncertified catalogue track `get_track` can't reach, a dead coordinate, a
 * network fault) is DROPPED rather than blanking the whole load. Duplicates are collapsed by
 * set token, so a set never carries the same row twice.
 */
export async function resolveChainFromTokens(
  tokens: string[],
  fetchToken: (token: string) => Promise<MixTrack | null>,
): Promise<MixTrack[]> {
  const seen = new Set<string>();
  const chain: MixTrack[] = [];

  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);

    const track = await fetchToken(token);
    if (track && !chain.some((existing) => setToken(existing) === setToken(track))) {
      chain.push(track);
    }
  }

  return chain;
}
