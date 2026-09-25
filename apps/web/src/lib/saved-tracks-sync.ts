import { csrfJsonHeaders, fetchCsrfToken } from "./authed-fetch";
import {
  isSaved,
  markSavedTrack,
  mergeSavedTracks,
  type RemoteSavedTrack,
  replaceSavedTracks,
  restoreSavedTrack,
  type SavableTrack,
  savedTracks,
  type SavedTrack,
  saveTrack,
  unsaveTrack,
} from "./saved-tracks";

export const SAVED_TRACKS_PATH = "/api/v1/me/saved-findings";

export const MERGE_PUSH_BATCH = 30;

export const MERGE_BATCH_PAUSE_MS = 30 * 60 * 1000;

export const MERGE_LIMITED_BACKOFF_MS = 15 * 60 * 1000;

export type SaveWrite = "failed" | "limited" | "refused" | "saved";

export type ToggleOutcome =
  | { kept: "account" | "device" | "page"; outcome: "removed" | "saved" }
  | { kept: "device"; outcome: "full" };

export type MergeOutcome =
  | { outcome: "merged"; pulled: number; pushed: number }
  | { outcome: "skipped" }
  | { outcome: "stopped"; pulled: number; pushed: number; remaining: number }
  | { outcome: "unavailable" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let signedInUser: string | undefined;
let session = 0;
let csrf: Promise<string | undefined> | undefined;
const mergedUsers = new Set<string>();

export function setSavedTracksUser(userId: string | undefined): void {
  if (userId !== signedInUser) {
    csrf = undefined;
    session += 1;
    mergedUsers.clear();
  }

  signedInUser = userId;
}

export function savedTracksUser(): string | undefined {
  return signedInUser;
}

export function resetSavedTracksSync(): void {
  signedInUser = undefined;
  session += 1;
  csrf = undefined;
  mergedUsers.clear();
}

function csrfToken(): Promise<string | undefined> {
  csrf ??= fetchCsrfToken({ onLapsedSession: "ignore" })
    .then((token) => token || undefined)
    .catch(() => undefined);

  return csrf.then((token) => {
    if (!token) {
      csrf = undefined;
    }

    return token;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRemoteSavedTrack(value: unknown): value is RemoteSavedTrack {
  return (
    isRecord(value) &&
    typeof value.trackId === "string" &&
    typeof value.title === "string" &&
    typeof value.savedAt === "string" &&
    Array.isArray(value.artists)
  );
}

export function parseRemoteSavedTracks(body: unknown): RemoteSavedTrack[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.savedFindings)) {
    return undefined;
  }

  return body.savedFindings.filter(isRemoteSavedTrack);
}

export function saveRequestBody(track: Pick<SavedTrack, "logId" | "trackId">): string {
  return JSON.stringify(
    track.logId ? { logId: track.logId, trackId: track.trackId } : { trackId: track.trackId },
  );
}

export async function writeSave(
  track: Pick<SavedTrack, "logId" | "trackId">,
  fetchImpl: FetchLike = fetch,
): Promise<SaveWrite> {
  const token = await csrfToken();

  if (!token) {
    return "failed";
  }

  const response = await fetchImpl(SAVED_TRACKS_PATH, {
    body: saveRequestBody(track),
    headers: csrfJsonHeaders(token),
    keepalive: true,
    method: "POST",
  }).catch(() => undefined);

  if (!response) {
    return "failed";
  }

  if (response.ok) {
    return "saved";
  }

  if (response.status === 404) {
    return "refused";
  }

  if (response.status === 429) {
    return "limited";
  }

  if (response.status === 403) {
    csrf = undefined;
  }

  return "failed";
}

export async function writeUnsave(trackId: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const token = await csrfToken();

  if (!token) {
    return false;
  }

  const response = await fetchImpl(`${SAVED_TRACKS_PATH}/${encodeURIComponent(trackId)}`, {
    headers: csrfJsonHeaders(token),
    keepalive: true,
    method: "DELETE",
  }).catch(() => undefined);

  if (response?.status === 403) {
    csrf = undefined;
  }

  return response?.ok === true || response?.status === 404;
}

function settle(trackId: string, write: SaveWrite): void {
  if (write === "saved") {
    markSavedTrack(trackId, "synced");
  } else if (write === "refused") {
    markSavedTrack(trackId, "refused");
  }
}

export function toggleSavedTrack(
  track: SavableTrack,
  fetchImpl: FetchLike = fetch,
  { onUnsaveFailed }: { onUnsaveFailed?: () => void } = {},
): ToggleOutcome {
  const account = signedInUser !== undefined;

  if (isSaved(track.trackId)) {
    const current = savedTracks();
    const index = current.findIndex((row) => row.trackId === track.trackId);
    const removed = current[index];

    const persisted = unsaveTrack(track.trackId);

    if (account && removed) {
      void writeUnsave(track.trackId, fetchImpl).then((ok) => {
        if (!ok) {
          restoreSavedTrack(removed, index);
          onUnsaveFailed?.();
        }
      });
    }

    if (account) {
      return { kept: "account", outcome: "removed" };
    }

    return { kept: persisted ? "device" : "page", outcome: "removed" };
  }

  const result = saveTrack(track, account ? { limit: Number.POSITIVE_INFINITY } : {});

  if (result.outcome === "full") {
    return { kept: "device", outcome: "full" };
  }

  if (account) {
    void writeSave(track, fetchImpl).then((write) => settle(track.trackId, write));

    return { kept: "account", outcome: "saved" };
  }

  return { kept: result.outcome === "saved" ? "device" : "page", outcome: "saved" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function unpushed(skip: ReadonlySet<string>): SavedTrack[] {
  return savedTracks().filter((row) => row.sync === "local" && !skip.has(row.trackId));
}

export async function mergeOnSignIn(
  userId: string,
  fetchImpl: FetchLike = fetch,
  { onBatch }: { onBatch?: () => void } = {},
): Promise<MergeOutcome> {
  if (mergedUsers.has(userId)) {
    return { outcome: "skipped" };
  }

  mergedUsers.add(userId);

  const run = session;
  const current = () => session === run && signedInUser === userId;
  const since = new Date().toISOString();
  const response = await fetchImpl(SAVED_TRACKS_PATH).catch(() => undefined);
  const remote = response?.ok
    ? parseRemoteSavedTracks(await response.json().catch(() => undefined))
    : undefined;

  if (!remote) {
    if (session === run) {
      mergedUsers.delete(userId);
    }

    return { outcome: "unavailable" };
  }

  const before = new Set(savedTracks().map((track) => track.trackId));
  const { next } = mergeSavedTracks(savedTracks(), remote, since);

  replaceSavedTracks(next);

  const pulled = next.filter((track) => !before.has(track.trackId)).length;
  const skip = new Set<string>();
  let pushed = 0;

  while (current()) {
    const batch = unpushed(skip).slice(0, MERGE_PUSH_BATCH);

    if (batch.length === 0) {
      return { outcome: "merged", pulled, pushed };
    }

    let limited = false;

    for (const track of batch) {
      if (!current()) {
        break;
      }

      if (!savedTracks().some((row) => row.trackId === track.trackId && row.sync === "local")) {
        continue;
      }

      const write = await writeSave(track, fetchImpl);

      if (write === "limited") {
        limited = true;
        break;
      }

      settle(track.trackId, write);

      if (write === "saved") {
        pushed += 1;
      } else if (write === "failed") {
        skip.add(track.trackId);
      }
    }

    if (!current()) {
      break;
    }

    onBatch?.();

    if (!limited && unpushed(skip).length === 0) {
      return { outcome: "merged", pulled, pushed };
    }

    await sleep(limited ? MERGE_LIMITED_BACKOFF_MS : MERGE_BATCH_PAUSE_MS);
  }

  return { outcome: "stopped", pulled, pushed, remaining: unpushed(skip).length };
}
