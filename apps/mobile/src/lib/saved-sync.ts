// Pure, React-Native-free logic for riding the device-local saved findings up onto a
// signed-in account (RFC: accounts in the pocket, slice 4). The device store stays the
// render source — offline-first, the law: the account only SYNCS. Two sync points and no
// third: (1) a union-merge once per sign-in (and once on a cold start that is already
// signed in), and (2) each local save/unsave mirrors to the account fire-and-forget. There
// is no periodic re-pull.
//
// The RULING (operator): the union-merge is a CLIENT-SIDE loop over the idempotent save op
// — zero new server surface. This module owns that loop's shape (what to push, what the
// union is, how a sparse account row adapts to the device snapshot) so it can be unit-tested
// in the repo's framework-free harness (see saved-sync.test.ts) with `fetch` mocked. The
// wiring — the shared cache, the session check, the AsyncStorage commit — lives in ./saved.ts,
// mirroring the saved-store.ts (pure) / saved.ts (wiring) split.

import { type SavedFinding, savedKey } from "@/lib/saved-store";

/**
 * One saved finding as the account list returns it — the `me-saved` contract's
 * `SavedFinding` (GET /api/me/saved-findings). The account carries only identity + the
 * render-minimal fields; the device snapshot's richer fields (album art, bpm, key, galaxy,
 * spotify) are device-capture only and are absent here.
 */
export type RemoteSavedFinding = {
  artists: string[];
  logId: string;
  note?: string;
  savedAt: string;
  title: string;
  trackId: string;
};

/**
 * The narrow fetch the sync loop needs — structurally satisfied by `meFetch` (which returns
 * a real `Response`). Kept RN-free and dependency-free so the loop is testable with a fake.
 */
export type SyncFetch = (
  path: string,
  init?: { body?: string; method?: string },
) => Promise<{ json: () => Promise<unknown>; ok: boolean }>;

const SAVED_FINDINGS_PATH = "/api/me/saved-findings";

/**
 * Adapt an account row to the device snapshot shape. The account list drops the device-only
 * render fields, so those stay undefined — the row still renders from title + artists + the
 * coordinate. `savedAt` parses the ISO string to epoch ms; a malformed timestamp becomes 0
 * so it sorts last rather than poisoning the sort with NaN.
 */
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

/**
 * The device saves the account is missing — the push list. Each is POSTed via the idempotent
 * save op so the account catches up to the device without a dedicated merge endpoint.
 */
export function localOnly(local: SavedFinding[], remote: RemoteSavedFinding[]): SavedFinding[] {
  const remoteKeys = new Set(remote.map(savedKey));
  return local.filter((row) => !remoteKeys.has(savedKey(row)));
}

/**
 * The union written back to the device store: every local snapshot plus every account row the
 * device is missing, newest-first. On a key collision the LOCAL snapshot wins — it carries the
 * richer render fields (album art, bpm, key) the account list does not.
 */
export function mergeUnion(local: SavedFinding[], remote: RemoteSavedFinding[]): SavedFinding[] {
  const localKeys = new Set(local.map(savedKey));
  const remoteOnly = remote.filter((row) => !localKeys.has(savedKey(row))).map(fromRemote);
  return [...local, ...remoteOnly].sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Tolerantly read the account list body (`{ ok, savedFindings }`) into rows, dropping anything
 * that does not carry the fields a merge needs. Never throws — a shape surprise yields [].
 */
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

/** Pull the account's saved findings, or null if the list is unreachable (no session, offline,
 * a non-OK status, or an unreadable body) — a null pull leaves the device store untouched. */
export async function pullRemoteSaved(fetch: SyncFetch): Promise<RemoteSavedFinding[] | null> {
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

/** Save one finding to the account (idempotent upsert by trackId). Returns whether it stuck;
 * a failure is swallowed by the caller (best-effort — the local row already renders). */
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

/** Remove one finding from the account (the path param resolves by trackId OR Log ID). */
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

/**
 * The union-merge, once per sign-in: pull the account list, push every device-only save up to
 * it (the idempotent-POST loop), and return the union to write back to the device store. If the
 * pull fails, the SAME `local` reference is returned unchanged — the caller uses that identity
 * to know it must NOT clobber the device store on a failed pull.
 */
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
