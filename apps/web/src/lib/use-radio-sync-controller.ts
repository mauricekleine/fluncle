import { useEffect, useRef } from "react";

export const HAVE_ENOUGH_DATA = 4;

export type MediaReadiness = Pick<HTMLMediaElement, "readyState"> | null;

export function canPlayThrough(element: MediaReadiness): boolean {
  return element !== null && element.readyState >= HAVE_ENOUGH_DATA;
}

export function bothReadyToStart({
  audio,
  reducedMotion,
  video,
}: {
  audio: MediaReadiness;
  reducedMotion: boolean;
  video: MediaReadiness;
}): boolean {
  if (!canPlayThrough(audio)) {
    return false;
  }

  if (reducedMotion) {
    return true;
  }

  return canPlayThrough(video);
}

export type RadioPhase = "idle" | "tuning" | "playing";

export function radioPhaseOnReady(current: RadioPhase): RadioPhase {
  return current === "tuning" ? "playing" : current;
}

export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinelLike | undefined>(undefined);

  useEffect(() => {
    const wakeLock =
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
        : undefined;

    if (!wakeLock) {
      return;
    }

    let cancelled = false;

    const release = () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = undefined;

      if (sentinel) {
        void sentinel.release().catch(() => {});
      }
    };

    const acquire = async () => {
      if (
        sentinelRef.current ||
        !active ||
        (typeof document !== "undefined" && document.visibilityState !== "visible")
      ) {
        return;
      }

      try {
        const sentinel = await wakeLock.request("screen");

        if (cancelled || !active) {
          void sentinel.release().catch(() => {});

          return;
        }

        sentinelRef.current = sentinel;

        sentinel.addEventListener?.("release", () => {
          if (sentinelRef.current === sentinel) {
            sentinelRef.current = undefined;
          }
        });
      } catch {}
    };

    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void acquire();
      } else {
        release();
      }
    };

    if (active) {
      void acquire();
      document.addEventListener("visibilitychange", onVisibility);
    } else {
      release();
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [active]);
}

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

type WakeLockLike = {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
};
