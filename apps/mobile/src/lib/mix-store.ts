// Pure, React-Native-free logic for the device-local set-in-progress — the chain and the
// taste seed behind it — so the add/remove/cap and (de)serialization can be unit-tested in
// the repo's framework-free harness (see saved-store.test.ts) without touching AsyncStorage.
//
// The I/O + the React hook live in ./mix.ts (which imports these); this module never imports
// RN or AsyncStorage so `bun test` can load it directly.
//
// Like the saved store, a chain row is a SNAPSHOT (the MixTrack the rail returned), not a
// live reference — so the chain renders instantly on a cold start, offline, before any
// refetch. The shareable, cross-surface truth is still the URL (mix-set.ts); this is only
// the phone's own "pick the tool back up where I left it".

import { type MixTrack } from "@fluncle/contracts";
import { MAX_SET_LENGTH, setToken } from "@/lib/mix-set";

/**
 * The device-local set: the ordered chain plus the taste seed the rail is tuned by, and — when
 * this chain was opened from (or saved to) an account set — that set's stable reference: its
 * `sourceSetId` AND `sourceSetName` (the name prefills the Save-set dialog, so a re-save keeps
 * the set's name unless the reader renames it).
 */
export type MixState = {
  chain: MixTrack[];
  sourceSetId?: string;
  sourceSetName?: string;
  taste: string[];
};

/** The storage envelope. Versioned so a future shape change can migrate or discard. */
export type MixEnvelope = {
  chain: MixTrack[];
  sourceSetId?: string;
  sourceSetName?: string;
  taste: string[];
  version: 1;
};

const CURRENT_VERSION = 1 as const;

/** The empty set — the cold-start value and what "Start over" resets to. */
export const EMPTY_MIX: MixState = { chain: [], taste: [] };

/** True ⇔ this track is already in the chain (keyed by its set token). */
export function inChain(chain: MixTrack[], track: { logId?: string; trackId: string }): boolean {
  const token = setToken(track);

  return chain.some((existing) => setToken(existing) === token);
}

/**
 * Append a track to the chain — a no-op if it is already in (a set holds each track once) or
 * if the chain is already at {@link MAX_SET_LENGTH} (the same cap the URL enforces, so a
 * device set never grows past what a link can carry).
 */
export function addTrack(chain: MixTrack[], track: MixTrack): MixTrack[] {
  if (inChain(chain, track) || chain.length >= MAX_SET_LENGTH) {
    return chain;
  }

  return [...chain, track];
}

/** Remove a track from the chain by its set token; a no-op if it wasn't there. */
export function removeTrack(chain: MixTrack[], token: string): MixTrack[] {
  return chain.filter((track) => setToken(track) !== token);
}

/** The chain as its ordered `?set=` tokens — the rail's exclusion list and the share set. */
export function chainTokens(chain: MixTrack[]): string[] {
  return chain.map(setToken);
}

/** Serialize the set to the versioned storage envelope. */
export function serialize(state: MixState): string {
  return JSON.stringify({
    chain: state.chain,
    // The account set this chain was opened from (if any) — Save set updates it in
    // place instead of minting a sibling (operator flag 2026-07-14). The name rides too,
    // so the Save-set dialog prefills with it.
    sourceSetId: state.sourceSetId,
    sourceSetName: state.sourceSetName,
    taste: state.taste,
    version: CURRENT_VERSION,
  } satisfies MixEnvelope);
}

/**
 * Read the set back from storage, tolerant of anything: a null/absent value, invalid JSON, a
 * wrong version, or a row missing the fields a chain renders from all resolve to the empty
 * set rather than throwing. Taste is filtered to the strings it should be.
 */
export function deserialize(raw: string | null | undefined): MixState {
  if (!raw) {
    return EMPTY_MIX;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_MIX;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return EMPTY_MIX;
  }

  const envelope = parsed as { chain?: unknown; taste?: unknown; version?: unknown };

  if (envelope.version !== CURRENT_VERSION) {
    return EMPTY_MIX;
  }

  const source = (parsed as { sourceSetId?: unknown }).sourceSetId;
  const sourceSetId = typeof source === "string" ? source : undefined;
  const sourceName = (parsed as { sourceSetName?: unknown }).sourceSetName;
  const sourceSetName = typeof sourceName === "string" ? sourceName : undefined;
  const chain = Array.isArray(envelope.chain) ? envelope.chain.filter(isMixTrack) : [];
  const taste = Array.isArray(envelope.taste)
    ? envelope.taste.filter((slug): slug is string => typeof slug === "string")
    : [];

  return { chain: chain.slice(0, MAX_SET_LENGTH), sourceSetId, sourceSetName, taste };
}

/**
 * A chain row is usable only if it carries the fields the row renders from — a trackId, a
 * title, an artists array, and the `certified` flag that picks its register. Anything short
 * of that is dropped (a partial row never resurrects into the chain).
 */
function isMixTrack(value: unknown): value is MixTrack {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const row = value as Record<string, unknown>;

  return (
    typeof row.trackId === "string" &&
    typeof row.title === "string" &&
    Array.isArray(row.artists) &&
    typeof row.certified === "boolean"
  );
}
