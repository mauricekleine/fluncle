// One shared <audio> element for the feed's in-place previews, so starting a
// preview anywhere stops the one already playing. Playback goes through the
// /api/preview proxy (official Deezer/iTunes previews only): the stored Deezer
// URLs carry expiring tokens, so the server re-resolves them on demand.
//
// useSyncExternalStore over module state keeps this a plain singleton instead
// of a context provider threaded through the feed.

import { useCallback, useSyncExternalStore } from "react";

function previewProxyUrl(idOrLogId: string): string {
  return `/api/preview/${encodeURIComponent(idOrLogId)}`;
}

type PreviewState = {
  status: "idle" | "loading" | "playing";
  trackId?: string;
};

const idleState: PreviewState = { status: "idle" };

let audio: HTMLAudioElement | undefined;
let state: PreviewState = idleState;
const listeners = new Set<() => void>();

function emit(next: PreviewState): void {
  state = next;

  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function stop(): void {
  audio?.pause();
  audio?.removeAttribute("src");
  emit(idleState);
}

function toggle(trackId: string): void {
  if (state.trackId === trackId && state.status !== "idle") {
    stop();
    return;
  }

  if (!audio) {
    audio = new Audio();
    audio.preload = "none";
    audio.addEventListener("ended", stop);
    audio.addEventListener("error", () => {
      // A dead preview degrades to silence; the row just returns to idle.
      if (state.status !== "idle") {
        emit(idleState);
      }
    });
    audio.addEventListener("playing", () => {
      emit({ status: "playing", trackId: state.trackId });
    });
  }

  audio.src = previewProxyUrl(trackId);
  emit({ status: "loading", trackId });
  audio.play().catch(() => {
    if (state.trackId === trackId) {
      emit(idleState);
    }
  });
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

// For a surface with MANY previewable items (e.g. the vibe map's placed dots):
// subscribe once and compare the active id per item, instead of one hook per row.
// `toggle` is the shared singleton, so starting one preview stops any other.
export function usePreviewControls(): {
  loadingTrackId: string | undefined;
  playingTrackId: string | undefined;
  toggle: (trackId: string) => void;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => idleState,
  );

  return {
    loadingTrackId: snapshot.status === "loading" ? snapshot.trackId : undefined,
    playingTrackId: snapshot.status === "idle" ? undefined : snapshot.trackId,
    toggle,
  };
}
