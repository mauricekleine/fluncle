import { useSyncExternalStore } from "react";

export const SAVED_TRACKS_KEY = "fluncle-saved-tracks";

export const MAX_SAVED_TRACKS = 500;

export type SavedTrackSync = "local" | "refused" | "synced";

export type SavedTrack = {
  artists: string[];
  coverUrl?: string;
  href?: string;
  logId?: string;
  savedAt: string;
  spotifyUrl?: string;
  sync: SavedTrackSync;
  title: string;
  trackId: string;
};

export type SavableTrack = Omit<SavedTrack, "savedAt" | "sync">;

export type SaveResult =
  | { outcome: "full" }
  | { outcome: "saved"; track: SavedTrack }
  | { outcome: "unpersisted"; track: SavedTrack };

export type RemoteSavedTrack = {
  artists: string[];
  href?: string;
  imageUrl?: string;
  logId?: string;
  savedAt: string;
  title: string;
  trackId: string;
};

const EMPTY: readonly SavedTrack[] = [];
const SYNC_STATES: readonly SavedTrackSync[] = ["local", "refused", "synced"];

let tracks: readonly SavedTrack[] = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toSavedTrack(value: unknown): SavedTrack | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const row = value as Record<string, unknown>;

  if (
    typeof row.trackId !== "string" ||
    row.trackId.length === 0 ||
    typeof row.title !== "string" ||
    typeof row.savedAt !== "string" ||
    !Array.isArray(row.artists)
  ) {
    return undefined;
  }

  const sync = SYNC_STATES.find((state) => state === row.sync) ?? "local";

  return {
    artists: row.artists.filter((artist): artist is string => typeof artist === "string"),
    coverUrl: optionalString(row.coverUrl),
    href: optionalString(row.href),
    logId: optionalString(row.logId),
    savedAt: row.savedAt,
    spotifyUrl: optionalString(row.spotifyUrl),
    sync,
    title: row.title,
    trackId: row.trackId,
  };
}

function newestFirst(a: SavedTrack, b: SavedTrack): number {
  return b.savedAt.localeCompare(a.savedAt);
}

export function parseSavedTracks(raw: string | null): SavedTrack[] {
  if (!raw) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const seen = new Set<string>();
  const rows: SavedTrack[] = [];

  for (const value of parsed) {
    const row = toSavedTrack(value);

    if (row && !seen.has(row.trackId)) {
      seen.add(row.trackId);
      rows.push(row);
    }
  }

  return rows.sort(newestFirst);
}

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readStored(): readonly SavedTrack[] | undefined {
  let raw: null | string;

  try {
    raw = storage()?.getItem(SAVED_TRACKS_KEY) ?? null;
  } catch {
    return undefined;
  }

  const rows = parseSavedTracks(raw);

  return rows.length === 0 ? EMPTY : rows;
}

function load(): void {
  if (loaded) {
    return;
  }

  loaded = true;
  tracks = readStored() ?? EMPTY;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function persist(rows: readonly SavedTrack[]): boolean {
  try {
    const store = storage();

    if (!store) {
      return false;
    }

    if (rows.length === 0) {
      store.removeItem(SAVED_TRACKS_KEY);
    } else {
      store.setItem(SAVED_TRACKS_KEY, JSON.stringify(rows));
    }

    return true;
  } catch {
    return false;
  }
}

function commit(next: readonly SavedTrack[]): boolean {
  tracks = next.length === 0 ? EMPTY : next;

  const persisted = persist(tracks);

  notify();

  return persisted;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== SAVED_TRACKS_KEY) {
    return;
  }

  const stored = readStored();

  if (!stored) {
    return;
  }

  tracks = stored;
  notify();
}

export function subscribeSavedTracks(listener: () => void): () => void {
  load();

  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  listeners.add(listener);

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function snapshot(): readonly SavedTrack[] {
  load();

  return tracks;
}

function serverSnapshot(): readonly SavedTrack[] {
  return EMPTY;
}

export function savedTracks(): readonly SavedTrack[] {
  return snapshot();
}

export function isSaved(trackId: string): boolean {
  return snapshot().some((track) => track.trackId === trackId);
}

export function saveTrack(
  track: SavableTrack,
  { limit = MAX_SAVED_TRACKS, now = new Date() }: { limit?: number; now?: Date } = {},
): SaveResult {
  const current = snapshot();
  const others = current.filter((row) => row.trackId !== track.trackId);

  if (others.length === current.length && current.length >= limit) {
    return { outcome: "full" };
  }

  const saved: SavedTrack = {
    artists: track.artists,
    coverUrl: track.coverUrl,
    href: track.href,
    logId: track.logId,
    savedAt: now.toISOString(),
    spotifyUrl: track.spotifyUrl,
    sync: "local",
    title: track.title,
    trackId: track.trackId,
  };

  const persisted = commit([saved, ...others]);

  return persisted ? { outcome: "saved", track: saved } : { outcome: "unpersisted", track: saved };
}

export function restoreSavedTrack(track: SavedTrack, index: number): void {
  const current = snapshot();

  if (current.some((row) => row.trackId === track.trackId)) {
    return;
  }

  const at = Math.max(0, Math.min(index, current.length));

  commit([...current.slice(0, at), track, ...current.slice(at)]);
}

export function unsaveTrack(trackId: string): boolean {
  const current = snapshot();

  if (!current.some((row) => row.trackId === trackId)) {
    return true;
  }

  if (commit(current.filter((row) => row.trackId !== trackId))) {
    return true;
  }

  return !readStored()?.some((row) => row.trackId === trackId);
}

export function markSavedTrack(trackId: string, sync: SavedTrackSync): void {
  const current = snapshot();

  if (current.some((row) => row.trackId === trackId && row.sync !== sync)) {
    commit(current.map((row) => (row.trackId === trackId ? { ...row, sync } : row)));
  }
}

export function forgetSyncedTracks(): void {
  const current = snapshot();

  if (current.some((row) => row.sync === "synced")) {
    commit(current.filter((row) => row.sync !== "synced"));
  }
}

export function replaceSavedTracks(next: readonly SavedTrack[]): void {
  commit(next);
}

export function fromRemoteSavedTrack(row: RemoteSavedTrack): SavedTrack {
  return {
    artists: row.artists,
    coverUrl: row.imageUrl,
    href: row.href ?? (row.logId ? `/log/${row.logId}` : undefined),
    logId: row.logId,
    savedAt: row.savedAt,
    sync: "synced",
    title: row.title,
    trackId: row.trackId,
  };
}

export function mergeSavedTracks(
  local: readonly SavedTrack[],
  remote: readonly RemoteSavedTrack[],
  since: string,
): { next: SavedTrack[]; pending: SavedTrack[] } {
  const remoteById = new Map(remote.map((row) => [row.trackId, row]));
  const localIds = new Set(local.map((row) => row.trackId));
  const kept: SavedTrack[] = [];

  for (const row of local) {
    const match = remoteById.get(row.trackId);

    if (match) {
      kept.push({
        ...row,
        coverUrl: row.coverUrl ?? match.imageUrl,
        href: row.href ?? match.href,
        logId: row.logId ?? match.logId,
        sync: "synced",
      });
    } else if (row.sync !== "synced" || row.savedAt >= since) {
      kept.push(row);
    }
  }

  const arrived = remote.filter((row) => !localIds.has(row.trackId)).map(fromRemoteSavedTrack);
  const next = [...kept, ...arrived].sort(newestFirst);

  return { next, pending: next.filter((row) => row.sync === "local") };
}

export function useSavedTracks(): readonly SavedTrack[] {
  return useSyncExternalStore(subscribeSavedTracks, snapshot, serverSnapshot);
}

export function useIsSaved(trackId: string): boolean {
  return useSyncExternalStore(
    subscribeSavedTracks,
    () => snapshot().some((track) => track.trackId === trackId),
    () => false,
  );
}
