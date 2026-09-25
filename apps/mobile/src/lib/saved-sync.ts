import { type SavedFinding, savedKey } from "@/lib/saved-store";

export type RemoteSavedFinding = {
  artists: string[];
  logId: string;
  note?: string;
  savedAt: string;
  title: string;
  trackId: string;
};

export type SyncFetch = (
  path: string,
  init?: { body?: string; method?: string },
) => Promise<{ json: () => Promise<unknown>; ok: boolean }>;

const SAVED_FINDINGS_PATH = "/api/v1/me/saved-findings";

export function fromRemote(row: RemoteSavedFinding): SavedFinding {
  const parsed = Date.parse(row.savedAt);
  return {
    artists: row.artists,
    logId: row.logId,
    savedAt: Number.isNaN(parsed) ? 0 : parsed,
    title: row.title,
    trackId: row.trackId,
  };
}

export function localOnly(local: SavedFinding[], remote: RemoteSavedFinding[]): SavedFinding[] {
  const remoteKeys = new Set(remote.map(savedKey));
  return local.filter((row) => !remoteKeys.has(savedKey(row)));
}

export function mergeUnion(local: SavedFinding[], remote: RemoteSavedFinding[]): SavedFinding[] {
  const localKeys = new Set(local.map(savedKey));
  const remoteOnly = remote.filter((row) => !localKeys.has(savedKey(row))).map(fromRemote);
  return [...local, ...remoteOnly].sort((a, b) => b.savedAt - a.savedAt);
}

export function parseRemoteList(body: unknown): RemoteSavedFinding[] {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const envelope = body as { savedFindings?: unknown };
  if (!Array.isArray(envelope.savedFindings)) {
    return [];
  }
  return envelope.savedFindings.filter(isRemoteSavedFinding);
}

function isRemoteSavedFinding(value: unknown): value is RemoteSavedFinding {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.trackId === "string" &&
    typeof row.logId === "string" &&
    typeof row.title === "string" &&
    typeof row.savedAt === "string" &&
    Array.isArray(row.artists)
  );
}

async function pullRemoteSaved(fetch: SyncFetch): Promise<RemoteSavedFinding[] | null> {
  let response: Awaited<ReturnType<SyncFetch>>;
  try {
    response = await fetch(SAVED_FINDINGS_PATH, { method: "GET" });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  try {
    return parseRemoteList(await response.json());
  } catch {
    return null;
  }
}

export async function pushSavedFinding(
  fetch: SyncFetch,
  finding: Pick<SavedFinding, "logId" | "trackId">,
): Promise<boolean> {
  try {
    const response = await fetch(SAVED_FINDINGS_PATH, {
      body: JSON.stringify({ logId: finding.logId, trackId: finding.trackId }),
      method: "POST",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteSavedFinding(fetch: SyncFetch, trackId: string): Promise<boolean> {
  try {
    const response = await fetch(`${SAVED_FINDINGS_PATH}/${encodeURIComponent(trackId)}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runUnionMerge(deps: {
  fetch: SyncFetch;
  local: SavedFinding[];
}): Promise<{ merged: SavedFinding[]; pushed: number }> {
  const remote = await pullRemoteSaved(deps.fetch);
  if (remote === null) {
    return { merged: deps.local, pushed: 0 };
  }

  let pushed = 0;
  for (const row of localOnly(deps.local, remote)) {
    if (await pushSavedFinding(deps.fetch, row)) {
      pushed += 1;
    }
  }

  return { merged: mergeUnion(deps.local, remote), pushed };
}
