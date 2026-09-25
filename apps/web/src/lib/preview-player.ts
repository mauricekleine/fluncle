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

export type QueueTrack = {
  artists: string[];
  coverUrl?: string;

  href?: string;
  id: string;

  lit?: boolean;
  similar?: boolean;
  spotifyUrl?: string;
  title: string;
};

export type QueueContinuation = { href: string; kind: "page" } | { kind: "similar" };

export type QueueState = {
  continuation?: QueueContinuation;

  ended: boolean;
  index: number;
  tracks: QueueTrack[];
};

const MAX_CONSECUTIVE_MISSES = 5;

let audio: HTMLAudioElement | undefined;
let pendingPublicPreview = false;
let state: PreviewState = idleState;
let progress: PreviewProgress = idleProgress;
let queue: QueueState | undefined;
let misses: ReadonlySet<string> = new Set();
let consecutiveMisses = 0;

let loadToken = 0;

let playAttempt = 0;

let playbackGeneration = 0;

const PAGE_HANDOFF_TTL_MS = 30_000;

type PageHandoff = { at: number; generation: number; href: string };

let pendingPageContinuation: PageHandoff | undefined;

export const TRAIL_MAX = 5;

let trail: readonly QueueTrack[] = [];
const trailListeners = new Set<() => void>();

function recordSeed(seed: QueueTrack | undefined): void {
  if (!seed || trail.some((item) => item.id === seed.id)) {
    return;
  }

  trail = [...trail, seed].slice(-TRAIL_MAX);
  notify(trailListeners);
}

function clearTrail(): void {
  if (trail.length === 0) {
    return;
  }

  trail = [];
  notify(trailListeners);
}

function subscribeTrail(listener: () => void): () => void {
  trailListeners.add(listener);

  return () => trailListeners.delete(listener);
}

let soundingGeneration = -1;

function soundStillWanted(): boolean {
  return soundingGeneration === playbackGeneration;
}

function supersedeIntent(): void {
  playbackGeneration += 1;
  pendingPageContinuation = undefined;
}
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

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : undefined;
}

export type StartOrigin = "automatic" | "listener";

function attemptPlay(
  element: HTMLAudioElement,
  trackId: string | undefined,
  origin: StartOrigin = "listener",
): void {
  playAttempt += 1;

  const attempt = playAttempt;
  const token = loadToken;

  claimMediaSession();

  if (origin === "listener") {
    silenceOtherMedia();
  }

  element.play().catch((error: unknown) => {
    const name = errorName(error);

    if (attempt !== playAttempt || token !== loadToken || name === "AbortError") {
      return;
    }

    if (name === "NotAllowedError") {
      pendingPublicPreview = false;
      emit({ status: "paused", trackId });

      return;
    }

    failCurrent(token);
  });
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
  playAttempt += 1;
  supersedeIntent();
  audio?.pause();
  audio?.removeAttribute("src");
  emit(idleState);
  emitProgress(idleProgress);
}

function onEnded(): void {
  if (!soundStillWanted()) {
    if (state.status === "playing" || state.status === "loading") {
      emit({ status: "paused", trackId: state.trackId });
    }

    return;
  }

  if (!queue) {
    stop();

    return;
  }

  consecutiveMisses = 0;
  advance("automatic");
}

function advance(origin: StartOrigin = "listener"): void {
  if (!queue) {
    return;
  }

  const next = queue.index + 1;

  if (next < queue.tracks.length) {
    if (origin === "automatic" && otherMediaActive()) {
      yieldToOtherMedia(next);

      return;
    }

    playAt(next, origin);

    return;
  }

  stop();
  emitQueue({ ...queue, ended: true });
}

function failCurrent(token: number): void {
  if (token !== loadToken) {
    return;
  }

  pendingPublicPreview = false;

  const trackId = state.trackId;

  if (trackId) {
    markMissing(trackId);
  }

  if (state.status === "paused" || !soundStillWanted()) {
    return;
  }

  if (queue && queue.tracks[queue.index]?.id === trackId) {
    consecutiveMisses += 1;

    if (consecutiveMisses < MAX_CONSECUTIVE_MISSES) {
      advance("automatic");

      return;
    }
  }

  consecutiveMisses = 0;

  if (state.status !== "idle") {
    emit(idleState);
    emitProgress(idleProgress);
  }
}

function noticeUnrequestedPause(element: HTMLAudioElement): void {
  if (!element.paused || element.ended) {
    return;
  }

  if (state.status === "playing" || state.status === "loading") {
    supersedeIntent();
    playAttempt += 1;
    emit({ status: "paused", trackId: state.trackId });
  }
}

function noticeLivePause(): void {
  if (audio) {
    noticeUnrequestedPause(audio);
  }
}

function ensureAudio(): HTMLAudioElement {
  if (audio) {
    return audio;
  }

  const element = new Audio();
  element.preload = "none";

  element.addEventListener("ended", () => {
    noticeUnrequestedPause(element);

    if (!element.ended) {
      return;
    }

    onEnded();
  });
  element.addEventListener("error", () => {
    noticeUnrequestedPause(element);

    if (element.error === null) {
      return;
    }

    failCurrent(loadToken);
  });
  element.addEventListener("playing", () => {
    noticeUnrequestedPause(element);

    if (element.paused || element.ended || !soundStillWanted()) {
      return;
    }

    emit({ status: "playing", trackId: state.trackId });
    consecutiveMisses = 0;

    if (pendingPublicPreview) {
      pendingPublicPreview = false;
      emitDiscoveryEvent("discovery_preview");
    }
  });
  element.addEventListener("pause", () => {
    noticeUnrequestedPause(element);
  });
  element.addEventListener("timeupdate", () => emitProgress(readTime()));
  element.addEventListener("loadedmetadata", () => emitProgress(readTime()));
  element.addEventListener("durationchange", () => emitProgress(readTime()));
  audio = element;
  installOneSoundGuard();

  return element;
}

export function startPreview(trackId: string, options?: StartPreviewOptions): void {
  if (queue) {
    emitQueue(undefined);
  }

  load(trackId, options);
}

function load(
  trackId: string,
  options?: StartPreviewOptions,
  origin: StartOrigin = "listener",
): void {
  pendingPublicPreview = shouldEmitDiscoveryPreview(options);

  const element = ensureAudio();
  loadToken += 1;
  supersedeIntent();
  soundingGeneration = playbackGeneration;

  element.src = options?.src ?? previewProxyUrl(trackId);
  emit({ status: "loading", trackId });
  emitProgress(idleProgress);
  attemptPlay(element, trackId, origin);
}

function playAt(index: number, origin: StartOrigin = "listener"): void {
  if (!queue) {
    return;
  }

  const track = queue.tracks[index];

  if (!track) {
    return;
  }

  emitQueue({ ...queue, ended: false, index });
  load(track.id, { publicPreview: true }, origin);
}

export function playQueue(
  tracks: QueueTrack[],
  startIndex: number,
  options?: {
    continuation?: QueueContinuation;
    origin?: StartOrigin;
    seed?: QueueTrack;
  },
): void {
  if (tracks.length === 0) {
    return;
  }

  const index = Math.min(Math.max(0, startIndex), tracks.length - 1);

  recordSeed(options?.seed);
  consecutiveMisses = 0;
  emitQueue({ continuation: options?.continuation, ended: false, index, tracks });
  load(tracks[index]?.id ?? "", { publicPreview: true }, options?.origin);
}

function toggle(trackId: string, options?: StartPreviewOptions): void {
  if (state.trackId === trackId && state.status !== "idle") {
    stop();

    return;
  }

  startPreview(trackId, options);
}

function pauseResume(): void {
  if (!audio) {
    return;
  }

  if (state.status === "playing" || state.status === "loading") {
    pausePreview();

    return;
  }

  if (state.status === "paused") {
    supersedeIntent();
    soundingGeneration = playbackGeneration;
    emit({ status: "loading", trackId: state.trackId });
    attemptPlay(audio, state.trackId);
  }
}

export function pausePreview(): void {
  supersedeIntent();

  if (audio && (state.status === "playing" || state.status === "loading")) {
    playAttempt += 1;
    audio.pause();
    emit({ status: "paused", trackId: state.trackId });
  }
}

export function togglePlayback(): void {
  if (state.status === "playing" || state.status === "loading" || state.status === "paused") {
    pauseResume();

    return;
  }

  if (state.status === "idle" && queue) {
    playAt(queue.index);
  }
}

export function skipNext(): void {
  if (queue) {
    consecutiveMisses = 0;
    advance();
  }
}

export function skipPrevious(): void {
  if (!queue) {
    return;
  }

  if (audio && audio.currentTime > 3) {
    audio.currentTime = 0;

    return;
  }

  playAt(Math.max(0, queue.index - 1));
}

export function stopPreview(): void {
  stop();
}

export function dismissPlayer(): void {
  stop();
  emitQueue(undefined);
  clearTrail();
  releaseMediaSession();
}

export type KeepGoingOutcome = "moved" | "none" | "stale";

export async function keepGoing(options: {
  loadSimilar: (last: QueueTrack) => Promise<QueueTrack[]>;
  navigate: (href: string) => void;
}): Promise<KeepGoingOutcome> {
  if (!queue) {
    return "none";
  }

  supersedeIntent();

  const asked = queue;
  const generation = playbackGeneration;

  const continuation = queue.continuation ?? { kind: "similar" };

  if (continuation.kind === "page") {
    pendingPageContinuation = { at: Date.now(), generation, href: continuation.href };
    options.navigate(continuation.href);

    return "moved";
  }

  const last = asked.tracks[asked.tracks.length - 1];

  if (!last) {
    return "none";
  }

  const heard = new Set(asked.tracks.map((track) => track.id));
  const found = await options.loadSimilar(last);

  noticeLivePause();

  if (queue !== asked || playbackGeneration !== generation) {
    return "stale";
  }

  if (otherMediaActive()) {
    yieldToOtherMedia();

    return "stale";
  }

  const next = found.filter((track) => !heard.has(track.id));

  if (next.length === 0) {
    return "none";
  }

  playQueue(next, 0, { continuation: { kind: "similar" }, origin: "automatic", seed: last });

  return "moved";
}

export function claimPageContinuation(href: string): boolean {
  noticeLivePause();

  const handoff = pendingPageContinuation;

  pendingPageContinuation = undefined;

  const honoured =
    handoff !== undefined &&
    handoff.generation === playbackGeneration &&
    Date.now() - handoff.at <= PAGE_HANDOFF_TTL_MS &&
    samePath(handoff.href, href);

  if (honoured && otherMediaActive()) {
    yieldToOtherMedia();

    return false;
  }

  return honoured;
}

export function expirePageContinuation(href: string): void {
  if (pendingPageContinuation !== undefined && !samePath(pendingPageContinuation.href, href)) {
    pendingPageContinuation = undefined;
  }
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

export function usePreviewStatus(trackId: string | undefined): PreviewStatus {
  return useSyncExternalStore(
    subscribe,
    () => (trackId !== undefined && state.trackId === trackId ? state.status : "idle"),
    () => "idle",
  );
}

export function usePreviewMissing(trackId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeMisses,
    () => trackId !== undefined && misses.has(trackId),
    () => false,
  );
}

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

export function usePlayerQueue(): QueueState | undefined {
  return useSyncExternalStore(
    subscribeQueue,
    () => queue,
    () => undefined,
  );
}

export function useSonicTrail(): readonly QueueTrack[] {
  return useSyncExternalStore(
    subscribeTrail,
    () => trail,
    () => EMPTY_TRAIL,
  );
}

const EMPTY_TRAIL: readonly QueueTrack[] = [];

export function readPlayer(): {
  missing: ReadonlySet<string>;
  queue: QueueState | undefined;
  status: PreviewStatus;
  trackId: string | undefined;
  trail: readonly QueueTrack[];
} {
  return { missing: misses, queue, status: state.status, trackId: state.trackId, trail };
}

export function resetPreviewPlayer(): void {
  stop();
  audio = undefined;
  queue = undefined;
  trail = [];
  misses = new Set();
  consecutiveMisses = 0;
  pendingPageContinuation = undefined;
  oneSoundGuardInstalled = false;
  mediaSessionOwned = false;
  playAttempt = 0;
  playbackGeneration = 0;
  soundingGeneration = -1;
}

export function usePreviewProgress(): PreviewProgress {
  return useSyncExternalStore(
    subscribeProgress,
    () => progress,
    () => idleProgress,
  );
}

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

    releaseMediaSession();
  }
}

function otherMediaActive(): boolean {
  if (typeof document === "undefined" || typeof HTMLMediaElement === "undefined") {
    return false;
  }

  return Array.from(document.querySelectorAll("audio, video")).some(
    (element) =>
      element instanceof HTMLMediaElement &&
      element !== audio &&
      !element.paused &&
      !element.ended &&
      !element.muted &&
      element.volume > 0,
  );
}

function yieldToOtherMedia(nextIndex?: number): void {
  stop();

  if (queue && nextIndex !== undefined) {
    emitQueue({ ...queue, ended: false, index: nextIndex });
  }
}

function silenceOtherMedia(): void {
  if (typeof document === "undefined" || typeof HTMLMediaElement === "undefined") {
    return;
  }

  for (const element of Array.from(document.querySelectorAll("audio, video"))) {
    if (
      element instanceof HTMLMediaElement &&
      element !== audio &&
      !element.paused &&
      !element.muted
    ) {
      element.pause();
    }
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

let mediaSessionOwned = false;

const MEDIA_SESSION_ACTIONS: MediaSessionAction[] = ["play", "pause", "nexttrack", "previoustrack"];

function mediaSession(): MediaSession | undefined {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return undefined;
  }

  return navigator.mediaSession;
}

function setMediaSessionHandlers(session: MediaSession, own: boolean): void {
  const handlers: Record<string, () => void> = {
    nexttrack: skipNext,
    pause: pausePreview,
    play: togglePlayback,
    previoustrack: skipPrevious,
  };

  for (const action of MEDIA_SESSION_ACTIONS) {
    try {
      session.setActionHandler(action, own ? (handlers[action] ?? null) : null);
    } catch {}
  }
}

function claimMediaSession(): void {
  const session = mediaSession();

  if (!session) {
    return;
  }

  if (!mediaSessionOwned) {
    mediaSessionOwned = true;
    setMediaSessionHandlers(session, true);
  }

  syncMediaSessionMetadata();
}

function releaseMediaSession(): void {
  const session = mediaSession();

  if (!session || !mediaSessionOwned) {
    return;
  }

  mediaSessionOwned = false;
  setMediaSessionHandlers(session, false);
  session.metadata = null;
  session.playbackState = "none";
}

function syncMediaSessionMetadata(): void {
  const session = mediaSession();

  if (!session || !mediaSessionOwned || typeof MediaMetadata === "undefined") {
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

  if (!session || !mediaSessionOwned) {
    return;
  }

  session.playbackState =
    state.status === "playing" || state.status === "loading"
      ? "playing"
      : state.status === "paused" || queue !== undefined
        ? "paused"
        : "none";
}
