// One shared <audio> element for the app's in-place previews, so starting a
// preview anywhere stops the one already playing. Playback goes through the
// /api/preview proxy (official Deezer/iTunes previews only): the stored Deezer
// URLs carry expiring tokens, so the server re-resolves them on demand.
//
// useSyncExternalStore over module state keeps this a plain singleton instead
// of a context provider threaded through the feed. Two independent stores share
// the one element: the STATUS store (which track, playing/paused) that the row
// controls read, and a separate PROGRESS store (elapsed/total) that only the
// /mix bottom bar subscribes to — so the bar's ~4Hz timeupdate never re-renders
// every previewable row.

import { useCallback, useSyncExternalStore } from "react";

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

let audio: HTMLAudioElement | undefined;
let state: PreviewState = idleState;
let progress: PreviewProgress = idleProgress;
const listeners = new Set<() => void>();
const progressListeners = new Set<() => void>();

function emit(next: PreviewState): void {
  state = next;

  for (const listener of listeners) {
    listener();
  }
}

function emitProgress(next: PreviewProgress): void {
  progress = next;

  for (const listener of progressListeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function subscribeProgress(listener: () => void): () => void {
  progressListeners.add(listener);

  return () => progressListeners.delete(listener);
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
  audio?.pause();
  audio?.removeAttribute("src");
  emit(idleState);
  emitProgress(idleProgress);
}

function ensureAudio(): HTMLAudioElement {
  if (audio) {
    return audio;
  }

  const element = new Audio();
  element.preload = "none";
  element.addEventListener("ended", stop);
  element.addEventListener("error", () => {
    // A dead preview degrades to silence; the row returns to idle and the bar
    // closes on its own (never a thrown error up the chain).
    if (state.status !== "idle") {
      emit(idleState);
      emitProgress(idleProgress);
    }
  });
  element.addEventListener("playing", () => emit({ status: "playing", trackId: state.trackId }));
  element.addEventListener("timeupdate", () => emitProgress(readTime()));
  element.addEventListener("loadedmetadata", () => emitProgress(readTime()));
  element.addEventListener("durationchange", () => emitProgress(readTime()));
  audio = element;

  return element;
}

function start(trackId: string): void {
  const element = ensureAudio();

  element.src = previewProxyUrl(trackId);
  emit({ status: "loading", trackId });
  emitProgress(idleProgress);
  element.play().catch(() => {
    if (state.trackId === trackId) {
      emit(idleState);
      emitProgress(idleProgress);
    }
  });
}

// The feed toggle (unchanged): the same track playing → stop; anything else → start.
// Used by the log-footage + note-dialog previews, which never pause.
function toggle(trackId: string): void {
  if (state.trackId === trackId && state.status !== "idle") {
    stop();

    return;
  }

  start(trackId);
}

// Pause/resume the CURRENT preview in place (the /mix bar + row overlays): the clip
// keeps its position so a resume picks up where it left off. A no-op while idle or
// still loading.
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
    emit({ status: "loading", trackId: state.trackId });
    audio.play().catch(() => {
      emit(idleState);
      emitProgress(idleProgress);
    });
  }
}

/** Stop the current preview (used when its row leaves the set). */
export function stopPreview(): void {
  stop();
}

export function usePreviewPlayer(trackId: string): {
  isActive: boolean;
  isLoading: boolean;
  toggle: () => void;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => idleState,
  );

  return {
    isActive: snapshot.trackId === trackId && snapshot.status !== "idle",
    isLoading: snapshot.trackId === trackId && snapshot.status === "loading",
    toggle: useCallback(() => toggle(trackId), [trackId]),
  };
}

// For a surface with MANY previewable rows (the /mix chain + candidate rails):
// subscribe once and compare the active id per row, instead of one hook per row.
// `start`/`pauseResume` are the shared singleton, so starting one preview stops any
// other, and pause/resume acts on whatever is current.
export function usePreviewControls(): {
  activeTrackId: string | undefined;
  pauseResume: () => void;
  start: (trackId: string) => void;
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
    start,
    status: snapshot.status,
  };
}

/** Elapsed/total seconds of the current preview — the /mix bar's own clock. */
export function usePreviewProgress(): PreviewProgress {
  return useSyncExternalStore(
    subscribeProgress,
    () => progress,
    () => idleProgress,
  );
}
