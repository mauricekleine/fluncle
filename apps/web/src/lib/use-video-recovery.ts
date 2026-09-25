import { type RefObject, useEffect, useRef } from "react";

export const HAVE_CURRENT_DATA = 2;

export function isVideoPlayable(video: Pick<HTMLVideoElement, "readyState"> | null): boolean {
  return video !== null && video.readyState >= HAVE_CURRENT_DATA;
}

export const STALL_TIMEOUT_MS = 6_000;

export const STALL_EVENT_GRACE_MS = 3_000;

export const STALL_TICK_MS = 1_000;

export const MAX_RECOVERY_ATTEMPTS = 3;

export type MediaStallSnapshot = {
  readyState: number;

  msSinceLoadStart: number;

  msSinceLastProgress: number;

  msSinceStallEvent: number | undefined;

  expectsPlayback: boolean;
};

export function mediaStallVerdict(snapshot: MediaStallSnapshot): boolean {
  if (!snapshot.expectsPlayback) {
    return false;
  }

  if (snapshot.readyState >= HAVE_CURRENT_DATA) {
    return false;
  }

  if (snapshot.msSinceLastProgress >= STALL_TIMEOUT_MS) {
    return true;
  }

  if (
    snapshot.msSinceStallEvent !== undefined &&
    snapshot.msSinceStallEvent >= STALL_EVENT_GRACE_MS
  ) {
    return true;
  }

  return false;
}

export type RecoveryLatchSnapshot = {
  recovered: boolean;

  msSinceRecovery: number;

  isPlayable: boolean;

  attempts: number;
};

export type RecoveryLatchAction = "hold" | "rearm" | "open";

export function recoveryLatchDecision(snapshot: RecoveryLatchSnapshot): RecoveryLatchAction {
  if (snapshot.attempts >= MAX_RECOVERY_ATTEMPTS) {
    return "hold";
  }

  if (!snapshot.recovered) {
    return "open";
  }

  if (snapshot.isPlayable || snapshot.msSinceRecovery >= STALL_TIMEOUT_MS) {
    return "rearm";
  }

  return "hold";
}

export function useVideoStallRecovery({
  expectsPlayback,
  onStall,
  src,
  videoRef,
}: {
  expectsPlayback: boolean;
  onStall: () => void;
  src: string | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
}): void {
  const onStallRef = useRef(onStall);
  onStallRef.current = onStall;

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !src || !expectsPlayback) {
      return;
    }

    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

    let loadStartAt = now();
    let lastProgressAt = loadStartAt;
    let lastReadyState = video.readyState;
    let stallEventAt: number | undefined;

    let recovered = false;
    let recoveredAt = 0;
    let attempts = 0;

    const markProgress = () => {
      lastProgressAt = now();
      stallEventAt = undefined;
    };

    const onLoadStart = () => {
      loadStartAt = now();
      lastProgressAt = loadStartAt;
      lastReadyState = video.readyState;
      stallEventAt = undefined;

      recovered = false;
      recoveredAt = 0;
      attempts = 0;
    };

    const onReadyProgress = () => {
      if (video.readyState > lastReadyState) {
        lastReadyState = video.readyState;
        markProgress();
      }
    };

    const onStalledOrWaiting = () => {
      if (video.readyState < HAVE_CURRENT_DATA && stallEventAt === undefined) {
        stallEventAt = now();
      }
    };

    const onPlayingOrCanPlay = () => {
      lastReadyState = video.readyState;
      markProgress();
    };

    video.addEventListener("loadstart", onLoadStart);
    video.addEventListener("emptied", onLoadStart);
    video.addEventListener("loadeddata", onReadyProgress);
    video.addEventListener("loadedmetadata", onReadyProgress);
    video.addEventListener("progress", onReadyProgress);
    video.addEventListener("canplay", onPlayingOrCanPlay);
    video.addEventListener("canplaythrough", onPlayingOrCanPlay);
    video.addEventListener("playing", onPlayingOrCanPlay);
    video.addEventListener("timeupdate", markProgress);
    video.addEventListener("stalled", onStalledOrWaiting);
    video.addEventListener("waiting", onStalledOrWaiting);

    const id = window.setInterval(() => {
      onReadyProgress();

      const t = now();
      const latch = recoveryLatchDecision({
        attempts,
        isPlayable: isVideoPlayable(video),
        msSinceRecovery: recovered ? t - recoveredAt : 0,
        recovered,
      });

      if (latch === "hold") {
        return;
      }

      if (latch === "rearm") {
        recovered = false;
      }

      const wedged = mediaStallVerdict({
        expectsPlayback: true,
        msSinceLastProgress: t - lastProgressAt,
        msSinceLoadStart: t - loadStartAt,
        msSinceStallEvent: stallEventAt === undefined ? undefined : t - stallEventAt,
        readyState: video.readyState,
      });

      if (wedged) {
        recovered = true;
        recoveredAt = t;
        attempts += 1;
        onStallRef.current();
      }
    }, STALL_TICK_MS);

    return () => {
      window.clearInterval(id);
      video.removeEventListener("loadstart", onLoadStart);
      video.removeEventListener("emptied", onLoadStart);
      video.removeEventListener("loadeddata", onReadyProgress);
      video.removeEventListener("loadedmetadata", onReadyProgress);
      video.removeEventListener("progress", onReadyProgress);
      video.removeEventListener("canplay", onPlayingOrCanPlay);
      video.removeEventListener("canplaythrough", onPlayingOrCanPlay);
      video.removeEventListener("playing", onPlayingOrCanPlay);
      video.removeEventListener("timeupdate", markProgress);
      video.removeEventListener("stalled", onStalledOrWaiting);
      video.removeEventListener("waiting", onStalledOrWaiting);
    };
  }, [videoRef, src, expectsPlayback]);
}
