import { csrfJsonHeaders, fetchCsrfToken } from "./authed-fetch";
import {
  isSaved,
  markSavedTrack,
  mergeSavedTracks,
  type RemoteSavedTrack,
  replaceSavedTracks,
  type SavableTrack,
  savedTracks,
  type SavedTrack,
  saveTrack,
  unsaveTrack,
} from "./saved-tracks";

export const SAVED_TRACKS_PATH = "/api/v1/me/saved-findings";

export const MERGE_PUSH_BATCH = 30;

export type SaveWrite = "failed" | "refused" | "saved";

export type ToggleOutcome = { kept: "account" | "device"; outcome: "removed" | "saved" };

export type MergeOutcome =
  | { outcome: "merged"; deferred: number; pulled: number; pushed: number }
  | { outcome: "skipped" }
  | { outcome: "unavailable" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let signedInUser: string | undefined;
let csrf: Promise<string | undefined> | undefined;
const mergedUsers = new Set<string>();

export function setSavedTracksUser(userId: string | undefined): void {
  if (userId !== signedInUser) {
    csrf = undefined;
  }

  signedInUser = userId;
}

export function savedTracksUser(): string | undefined {
  return signedInUser;
}

export function resetSavedTracksSync(): void {
  signedInUser = undefined;
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

  return response?.ok === true;
}

function settle(trackId: string, write: SaveWrite): void {
  if (write === "saved") {
    markSavedTrack(trackId, "synced");
  } else if (write === "refused") {
    markSavedTrack(trackId, "refused");
  }
}

export function toggleSavedTrack(track: SavableTrack, fetchImpl: FetchLike = fetch): ToggleOutcome {
  const kept = signedInUser ? "account" : "device";

  if (isSaved(track.trackId)) {
    unsaveTrack(track.trackId);

    if (signedInUser) {
      void writeUnsave(track.trackId, fetchImpl);
    }

    return { kept, outcome: "removed" };
  }

  saveTrack(track);

  if (signedInUser) {
    void writeSave(track, fetchImpl).then((write) => settle(track.trackId, write));
  }

  return { kept, outcome: "saved" };
}

export async function mergeOnSignIn(
  userId: string,
  fetchImpl: FetchLike = fetch,
): Promise<MergeOutcome> {
  if (mergedUsers.has(userId)) {
    return { outcome: "skipped" };
  }

  mergedUsers.add(userId);

  const since = new Date().toISOString();
  const response = await fetchImpl(SAVED_TRACKS_PATH).catch(() => undefined);
  const remote = response?.ok
    ? parseRemoteSavedTracks(await response.json().catch(() => undefined))
    : undefined;

  if (!remote) {
    mergedUsers.delete(userId);

    return { outcome: "unavailable" };
  }

  const before = new Set(savedTracks().map((track) => track.trackId));
  const { next, pending } = mergeSavedTracks(savedTracks(), remote, since);

  replaceSavedTracks(next);

  const batch = pending.slice(0, MERGE_PUSH_BATCH);
  let pushed = 0;

  for (const track of batch) {
    if (signedInUser !== userId) {
      break;
    }

    const write = await writeSave(track, fetchImpl);

    settle(track.trackId, write);

    if (write === "saved") {
      pushed += 1;
    }
  }

  return {
    deferred: pending.length - batch.length,
    outcome: "merged",
    pulled: next.filter((track) => !before.has(track.trackId)).length,
    pushed,
  };
}
