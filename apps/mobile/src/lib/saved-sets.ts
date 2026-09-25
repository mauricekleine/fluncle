import { type MixTrack } from "@fluncle/contracts";

export const SAVED_SETS_PATH = "/api/v1/me/saved-sets";

export type RemoteSavedSet = {
  createdAt: string;
  id: string;
  name: string;
  setTokens: string;
  taste?: string;
  updatedAt: string;
};

export function buildSaveSetBody(
  name: string,
  serializedSet: string,
  serializedTaste: string,
): { name: string; set: string; taste: string } {
  return { name: name.trim(), set: serializedSet, taste: serializedTaste };
}

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
