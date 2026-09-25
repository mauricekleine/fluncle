import { type MixTrack } from "@fluncle/contracts";
import { MAX_SET_LENGTH, setToken } from "@/lib/mix-set";

export type MixState = {
  chain: MixTrack[];
  sourceSetId?: string;
  sourceSetName?: string;
  taste: string[];
};

type MixEnvelope = {
  chain: MixTrack[];
  sourceSetId?: string;
  sourceSetName?: string;
  taste: string[];
  version: 1;
};

const CURRENT_VERSION = 1 as const;

export const EMPTY_MIX: MixState = { chain: [], taste: [] };

export function inChain(chain: MixTrack[], track: { logId?: string; trackId: string }): boolean {
  const token = setToken(track);

  return chain.some((existing) => setToken(existing) === token);
}

export function addTrack(chain: MixTrack[], track: MixTrack): MixTrack[] {
  if (inChain(chain, track) || chain.length >= MAX_SET_LENGTH) {
    return chain;
  }

  return [...chain, track];
}

export function removeTrack(chain: MixTrack[], token: string): MixTrack[] {
  return chain.filter((track) => setToken(track) !== token);
}

export function chainTokens(chain: MixTrack[]): string[] {
  return chain.map(setToken);
}

export function serialize(state: MixState): string {
  return JSON.stringify({
    chain: state.chain,

    sourceSetId: state.sourceSetId,
    sourceSetName: state.sourceSetName,
    taste: state.taste,
    version: CURRENT_VERSION,
  } satisfies MixEnvelope);
}

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
