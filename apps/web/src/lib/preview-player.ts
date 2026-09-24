// One shared <audio> element for the app's in-place previews, so starting a
// preview anywhere stops the one already playing. Playback goes through the
// /api/preview proxy (official Deezer/iTunes previews only): the stored Deezer
// URLs carry expiring tokens, so the server re-resolves them on demand.
//
// useSyncExternalStore over module state keeps this a plain singleton instead
// of a context provider threaded through the feed. Four independent stores share
// the one element, split by how often they change and who reads them:
//
//   - STATUS (which track, playing/paused/loading) — every play control reads it,
//     each through a per-row selector that returns a primitive, so a row
//     re-renders only when ITS state changes;
//   - QUEUE (the list being played, the position in it, whether it ran out) —
//     only the player bar reads it;
//   - PROGRESS (elapsed/total) — only the bars read it, so the ~4Hz timeupdate
//     never re-renders a previewable row;
//   - MISSES (tracks whose preview came back empty) — a row reads its own bit to
//     dim its play glyph.
//
// THE LIST IS THE QUEUE. Play on any row of a list hands the whole list to
// `playQueue` from that row; the element's `ended` advances to the next track,
// and the end of the list stops and offers one way on ("keep going": the last
// track's sonic neighbours, or the next page of a paginated list). Nothing plays
// that the listener did not start. A track whose preview is missing is skipped
// and remembered, so its row can dim.
//
// ONE SOUND AT A TIME. Any other audible media element on the page (Stories, the
// radio, a video someone unmutes) pauses the preview the moment it starts, and
// the chrome pauses it on the way into a surface that never shows the bar.

import { useCallback, useSyncExternalStore } from "react";
import {
  emitDiscoveryEvent,
  shouldEmitDiscoveryPreview,
  type StartPreviewOptions,
} from "./discovery-emit";

export type { StartPreviewOptions };

function previewProxyUrl(idOrLogId: string): string {
  return `/api/preview/${encodeURIComponent(idOrLogId)}`;
}

export type PreviewStatus = "idle" | "loading" | "paused" | "playing";

type PreviewState = {
  status: PreviewStatus;
  trackId?: string;
};

const idleState: PreviewState = { status: "idle" };

type PreviewProgress = {
  currentTime: number;
  duration: number;
};

const idleProgress: PreviewProgress = { currentTime: 0, duration: 0 };

/**
 * Exactly what the player bar needs to show and act on one queued track. `id` is the preview
 * relay key (a trackId, or a logId for a finding-only caller); everything else is display and
 * the playing track's actions. Built by each list from its own row type, so the store never
 * learns a surface's DTO.
 */
export type QueueTrack = {
  artists: string[];
  coverUrl?: string;
  /** The track's own page on fluncle.com: `/log/<id>` for a finding, `/track/<id>` otherwise. */
  href?: string;
  id: string;
  /** A finding (lit) or a catalogue track (unlit): the bar spends no gold on an unlit one. */
  lit?: boolean;
  spotifyUrl?: string;
  title: string;
};

/**
 * The one way on when a list runs out. `similar` asks the archive for the last track's sonic
 * neighbours; `page` walks to the next page of a paginated list and plays it from the top.
 */
export type QueueContinuation = { href: string; kind: "page" } | { kind: "similar" };

export type QueueState = {
  continuation?: QueueContinuation;
  /** The list ran out: the bar offers "keep going" instead of next. */
  ended: boolean;
  index: number;
  tracks: QueueTrack[];
};

/** A consecutive-miss ceiling, so a list of dead previews stops instead of skipping forever. */
const MAX_CONSECUTIVE_MISSES = 5;

let audio: HTMLAudioElement | undefined;
let pendingPublicPreview = false;
let state: PreviewState = idleState;
let progress: PreviewProgress = idleProgress;
let queue: QueueState | undefined;
let misses: ReadonlySet<string> = new Set();
let consecutiveMisses = 0;
// Every start bumps the token, so a late error or play() rejection from a clip that has since
// been replaced never acts on the one that replaced it.
let loadToken = 0;
let pendingPageContinuation: string | undefined;
const listeners = new Set<() => void>();
const progressListeners = new Set<() => void>();
const queueListeners = new Set<() => void>();
const missListeners = new Set<() => void>();

function notify(set: Set<() => void>): void {
  for (const listener of set) {
    listener();
  }
}

function emit(next: PreviewState): void {
  state = next;
  notify(listeners);
  syncMediaSessionState();
}

function emitProgress(next: PreviewProgress): void {
  progress = next;
  notify(progressListeners);
}

function emitQueue(next: QueueState | undefined): void {
  queue = next;
  notify(queueListeners);
  syncMediaSessionMetadata();
  syncMediaSessionState();
}

function markMissing(trackId: string): void {
  if (misses.has(trackId)) {
    return;
  }

  misses = new Set([...misses, trackId]);
  notify(missListeners);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function subscribeProgress(listener: () => void): () => void {
  progressListeners.add(listener);

  return () => progressListeners.delete(listener);
}

function subscribeQueue(listener: () => void): () => void {
  queueListeners.add(listener);

  return () => queueListeners.delete(listener);
}

function subscribeMisses(listener: () => void): () => void {
  missListeners.add(listener);

  return () => missListeners.delete(listener);
}

function readTime(): PreviewProgress {
  if (!audio) {
    return idleProgress;
  }

  return {
    currentTime: audio.currentTime,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
  };
}

function stop(): void {
  pendingPublicPreview = false;
  loadToken += 1;
  audio?.pause();
  audio?.removeAttribute("src");
  emit(idleState);
  emitProgress(idleProgress);
}

// The current clip finished. Inside a queue the next track starts; at the end of the list the
// bar keeps its place and offers the way on. Outside a queue the preview simply stops.
function onEnded(): void {
  if (!queue) {
    stop();

    return;
  }

  consecutiveMisses = 0;
  advance();
}

function advance(): void {
  if (!queue) {
    return;
  }

  const next = queue.index + 1;

  if (next < queue.tracks.length) {
    playAt(next);

    return;
  }

  stop();
  emitQueue({ ...queue, ended: true });
}

// A clip that cannot play. A queued track is remembered as missing and the queue moves on;
// anything else returns to idle. Never a thrown error up the chain.
function failCurrent(token: number): void {
  if (token !== loadToken) {
    return;
  }

  pendingPublicPreview = false;

  const trackId = state.trackId;

  if (trackId) {
    markMissing(trackId);
  }

  if (queue && queue.tracks[queue.index]?.id === trackId) {
    consecutiveMisses += 1;

    if (consecutiveMisses < MAX_CONSECUTIVE_MISSES) {
      advance();

      return;
    }
  }

  consecutiveMisses = 0;

  if (state.status !== "idle") {
    emit(idleState);
    emitProgress(idleProgress);
  }
}

function ensureAudio(): HTMLAudioElement {
  if (audio) {
    return audio;
  }

  const element = new Audio();
  element.preload = "none";
  element.addEventListener("ended", onEnded);
  element.addEventListener("error", () => {
    // A dead preview degrades to silence (or to the next track in a queue).
    failCurrent(loadToken);
  });
  element.addEventListener("playing", () => {
    emit({ status: "playing", trackId: state.trackId });
    consecutiveMisses = 0;

    if (pendingPublicPreview) {
      pendingPublicPreview = false;
      emitDiscoveryEvent("discovery_preview");
    }
  });
  element.addEventListener("pause", () => {
    // A pause the page did not ask for (the OS, a headset button, the one-sound guard) still
    // lands in the store, so every control reads the truth.
    if (state.status === "playing" && !element.ended) {
      emit({ status: "paused", trackId: state.trackId });
    }
  });
  element.addEventListener("timeupdate", () => emitProgress(readTime()));
  element.addEventListener("loadedmetadata", () => emitProgress(readTime()));
  element.addEventListener("durationchange", () => emitProgress(readTime()));
  audio = element;
  installOneSoundGuard();
  installMediaSessionHandlers();

  return element;
}

// `src` overrides the default preview proxy: the admin quarantine lens auditions the CAPTURED
// bytes (`/api/v1/admin/tracks/:id/source-audio`) through this same singleton, so starting a
// captured audition stops a preview and vice versa. One element, one thing playing, everywhere.
// Public visitor previews pass `publicPreview: true`. Admin starts omit it, even when they also
// omit `src` and use the public proxy. The event fires only after playback actually starts.
// A bare start leaves any queue behind: the bar belongs to lists and to callers that name their
// track (`playQueue`, or `usePreviewPlayer` with a `track`).
export function startPreview(trackId: string, options?: StartPreviewOptions): void {
  if (queue) {
    emitQueue(undefined);
  }

  load(trackId, options);
}

function load(trackId: string, options?: StartPreviewOptions): void {
  pendingPublicPreview = shouldEmitDiscoveryPreview(options);

  const element = ensureAudio();
  loadToken += 1;
  const token = loadToken;

  element.src = options?.src ?? previewProxyUrl(trackId);
  emit({ status: "loading", trackId });
  emitProgress(idleProgress);
  element.play().catch((error: unknown) => {
    if (token !== loadToken) {
      return;
    }

    // Autoplay refused (no user gesture yet, or the OS said no): the clip is fine, so it waits,
    // paused, for a tap. Anything else is a clip that cannot play.
    if (error instanceof Error && error.name === "NotAllowedError") {
      pendingPublicPreview = false;
      emit({ status: "paused", trackId });

      return;
    }

    failCurrent(token);
  });
}

function playAt(index: number): void {
  if (!queue) {
    return;
  }

  const track = queue.tracks[index];

  if (!track) {
    return;
  }

  emitQueue({ ...queue, ended: false, index });
  load(track.id, { publicPreview: true });
}

/**
 * Play a list from one of its rows: the list becomes the queue, in its own order, starting at
 * `startIndex`. Always a public preview — the rows that hand over a list are visitor controls.
 */
export function playQueue(
  tracks: QueueTrack[],
  startIndex: number,
  options?: { continuation?: QueueContinuation },
): void {
  if (tracks.length === 0) {
    return;
  }

  const index = Math.min(Math.max(0, startIndex), tracks.length - 1);

  consecutiveMisses = 0;
  emitQueue({ continuation: options?.continuation, ended: false, index, tracks });
  load(tracks[index]?.id ?? "", { publicPreview: true });
}

// The feed toggle: the same track playing → stop; anything else → start.
// Used by the note-dialog preview (admin), which never pauses.
function toggle(trackId: string, options?: StartPreviewOptions): void {
  if (state.trackId === trackId && state.status !== "idle") {
    stop();

    return;
  }

  startPreview(trackId, options);
}

// Pause/resume the CURRENT preview in place (the bars + row overlays): the clip keeps its
// position so a resume picks up where it left off. A no-op while idle or still loading.
function pauseResume(): void {
  if (!audio) {
    return;
  }

  if (state.status === "playing") {
    audio.pause();
    emit({ status: "paused", trackId: state.trackId });

    return;
  }

  if (state.status === "paused") {
    const token = loadToken;

    emit({ status: "loading", trackId: state.trackId });
    audio.play().catch(() => {
      if (token === loadToken) {
        emit({ status: "paused", trackId: state.trackId });
      }
    });
  }
}

/** Pause whatever is playing, keeping its place (the one-sound rule, the chromeless surfaces). */
export function pausePreview(): void {
  if (audio && (state.status === "playing" || state.status === "loading")) {
    audio.pause();
    emit({ status: "paused", trackId: state.trackId });
  }
}

/**
 * The player's play/pause: pause a playing clip, resume a paused one, and from idle restart the
 * queue's current track (a list that ran out plays its last track again).
 */
export function togglePlayback(): void {
  if (state.status === "playing" || state.status === "paused") {
    pauseResume();

    return;
  }

  if (state.status === "idle" && queue) {
    playAt(queue.index);
  }
}

/** Skip to the next track in the queue. At the end of the list it stops and offers the way on. */
export function skipNext(): void {
  if (queue) {
    consecutiveMisses = 0;
    advance();
  }
}

/** Back to the previous track in the queue; on the first track it restarts it. */
export function skipPrevious(): void {
  if (!queue) {
    return;
  }

  // Past the first few seconds, "previous" means "from the top" — the transport convention.
  if (audio && audio.currentTime > 3) {
    audio.currentTime = 0;

    return;
  }

  playAt(Math.max(0, queue.index - 1));
}

/** Stop the current preview (used when its row leaves the set). */
export function stopPreview(): void {
  stop();
}

/** Close the player: the sound stops and the bar goes away until the next play. */
export function dismissPlayer(): void {
  stop();
  emitQueue(undefined);
}

/**
 * The listener asked for more at the end of a list. `similar` fetches the last track's sonic
 * neighbours through `loadSimilar` (the caller owns the fetch, so this module stays free of
 * search); `page` leaves the navigation to the caller and arms a one-shot hand-off that the next
 * page's list consumes to start itself from the top.
 */
export async function keepGoing(options: {
  loadSimilar: (last: QueueTrack) => Promise<QueueTrack[]>;
  navigate: (href: string) => void;
}): Promise<boolean> {
  if (!queue) {
    return false;
  }

  const continuation = queue.continuation ?? { kind: "similar" };

  if (continuation.kind === "page") {
    pendingPageContinuation = continuation.href;
    options.navigate(continuation.href);

    return true;
  }

  const last = queue.tracks[queue.tracks.length - 1];

  if (!last) {
    return false;
  }

  const heard = new Set(queue.tracks.map((track) => track.id));
  const next = (await options.loadSimilar(last)).filter((track) => !heard.has(track.id));

  if (next.length === 0) {
    return false;
  }

  playQueue(next, 0, { continuation: { kind: "similar" } });

  return true;
}

/**
 * A list mounting under `href` claims a pending page hand-off: true once, for the page the
 * previous list asked for, so the new page plays from its first row. Pure bookkeeping; the list
 * starts itself.
 */
export function claimPageContinuation(href: string): boolean {
  if (pendingPageContinuation === undefined) {
    return false;
  }

  const matches = samePath(pendingPageContinuation, href);

  pendingPageContinuation = undefined;

  return matches;
}

function samePath(a: string, b: string): boolean {
  try {
    const base = "https://fluncle.invalid";
    const left = new URL(a, base);
    const right = new URL(b, base);

    return left.pathname === right.pathname && left.search === right.search;
  } catch {
    return a === b;
  }
}

export function usePreviewPlayer(
  trackId: string,
  options?: StartPreviewOptions & { track?: QueueTrack },
): {
  isActive: boolean;
  isLoading: boolean;
  toggle: () => void;
} {
  const status = usePreviewStatus(trackId);
  const publicPreview = options?.publicPreview === true;
  const src = options?.src;
  const track = options?.track;

  return {
    isActive: status === "playing" || status === "loading",
    isLoading: status === "loading",
    toggle: useCallback(() => {
      // A caller that names its track joins the player: the bar shows it and carries its
      // actions. Pause keeps the place; a second tap resumes.
      if (track && publicPreview) {
        if (state.trackId === trackId && state.status !== "idle") {
          pauseResume();

          return;
        }

        playQueue([track], 0);

        return;
      }

      toggle(trackId, { publicPreview, src });
    }, [publicPreview, src, track, trackId]),
  };
}

/**
 * One row's own status: `idle` unless this track is the current one. Returns a primitive, so a
 * list of fifty rows re-renders only the two whose state changed.
 */
export function usePreviewStatus(trackId: string | undefined): PreviewStatus {
  return useSyncExternalStore(
    subscribe,
    () => (trackId !== undefined && state.trackId === trackId ? state.status : "idle"),
    () => "idle",
  );
}

/** Whether this track's preview has come back empty this visit (its play glyph dims). */
export function usePreviewMissing(trackId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeMisses,
    () => trackId !== undefined && misses.has(trackId),
    () => false,
  );
}

// For a surface with MANY previewable rows (the /mix chain + candidate rails):
// subscribe once and compare the active id per row, instead of one hook per row.
// `start`/`pauseResume` are the shared singleton, so starting one preview stops any
// other, and pause/resume acts on whatever is current.
export function usePreviewControls(): {
  activeTrackId: string | undefined;
  pauseResume: () => void;
  start: typeof startPreview;
  status: PreviewStatus;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => idleState,
  );

  return {
    activeTrackId: snapshot.status === "idle" ? undefined : snapshot.trackId,
    pauseResume,
    start: startPreview,
    status: snapshot.status,
  };
}

/** The whole player state for the bar: the queue and the current status. */
export function usePlayerQueue(): QueueState | undefined {
  return useSyncExternalStore(
    subscribeQueue,
    () => queue,
    () => undefined,
  );
}

/** A plain read of the whole player, outside React (tests and one-off checks). */
export function readPlayer(): {
  missing: ReadonlySet<string>;
  queue: QueueState | undefined;
  status: PreviewStatus;
  trackId: string | undefined;
} {
  return { missing: misses, queue, status: state.status, trackId: state.trackId };
}

/** Drop the shared element so the next start constructs a fresh Audio (tests). */
export function resetPreviewPlayer(): void {
  stop();
  audio = undefined;
  queue = undefined;
  misses = new Set();
  consecutiveMisses = 0;
  pendingPageContinuation = undefined;
  oneSoundGuardInstalled = false;
  mediaSessionInstalled = false;
}

/** Elapsed/total seconds of the current preview — the bars' own clock. */
export function usePreviewProgress(): PreviewProgress {
  return useSyncExternalStore(
    subscribeProgress,
    () => progress,
    () => idleProgress,
  );
}

// ── ONE SOUND AT A TIME ──────────────────────────────────────────────────────────────────────
// Media events do not bubble, but they do run the capture phase, so one document listener hears
// every <video>/<audio> on the page. Only an AUDIBLE start counts: the log page's muted footage
// loop and the radio's muted pre-roll never pause the preview; someone unmuting one does.

let oneSoundGuardInstalled = false;

function onOtherMedia(event: Event): void {
  const target = event.target;

  if (
    typeof HTMLMediaElement === "undefined" ||
    !(target instanceof HTMLMediaElement) ||
    target === audio
  ) {
    return;
  }

  if (!target.paused && !target.muted && target.volume > 0) {
    pausePreview();
  }
}

function installOneSoundGuard(): void {
  if (oneSoundGuardInstalled || typeof document === "undefined") {
    return;
  }

  oneSoundGuardInstalled = true;
  document.addEventListener("play", onOtherMedia, true);
  document.addEventListener("playing", onOtherMedia, true);
  document.addEventListener("volumechange", onOtherMedia, true);
}

// ── MEDIA SESSION ────────────────────────────────────────────────────────────────────────────
// The lock screen and the headset buttons: the playing track's metadata and the transport that
// matches the bar (play, pause, next, previous). Feature-detected; a browser without the API
// simply has no lock-screen controls.

let mediaSessionInstalled = false;

function mediaSession(): MediaSession | undefined {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return undefined;
  }

  return navigator.mediaSession;
}

function installMediaSessionHandlers(): void {
  const session = mediaSession();

  if (mediaSessionInstalled || !session) {
    return;
  }

  mediaSessionInstalled = true;

  const handlers: [MediaSessionAction, () => void][] = [
    ["play", togglePlayback],
    ["pause", pausePreview],
    ["nexttrack", skipNext],
    ["previoustrack", skipPrevious],
  ];

  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // An action this browser does not support is simply absent from its controls.
    }
  }
}

function syncMediaSessionMetadata(): void {
  const session = mediaSession();

  if (!session || typeof MediaMetadata === "undefined") {
    return;
  }

  const track = queue?.tracks[queue.index];

  if (!track) {
    session.metadata = null;

    return;
  }

  session.metadata = new MediaMetadata({
    artist: track.artists.join(", "),
    artwork: track.coverUrl ? [{ src: track.coverUrl }] : [],
    title: track.title,
  });
}

function syncMediaSessionState(): void {
  const session = mediaSession();

  if (!session) {
    return;
  }

  // A list that ran out still holds its place (the bar keeps the last track and its way on), so
  // the lock screen reads paused rather than empty until the player is closed.
  session.playbackState =
    state.status === "playing" || state.status === "loading"
      ? "playing"
      : state.status === "paused" || queue !== undefined
        ? "paused"
        : "none";
}
