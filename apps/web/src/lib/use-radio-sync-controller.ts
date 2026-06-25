// radio.fluncle.com A/V sync primitives (the lean-back run must STAY in sync).
//
// Two field bugs motivate this module, both downstream of the same root cause —
// the video and the observation audio are two independent media elements that
// start on their own, with nothing coordinating them:
//
//   • The "restart" (double-start). The audio effect runs its setup → cleanup →
//     setup on a segment transition (a fresh `playhead` identity, and again under
//     React.StrictMode in dev). Two overlapping `audio.play()` promises race, the
//     drift-correction `timeupdate` then sees a bogus position and HARD-SEEKS ~1s
//     in — read on screen as a restart. The fix is a one-shot guard so `play()`
//     fires EXACTLY ONCE per segment (`segmentStartServerMs` is the segment key).
//
//   • The desync. Video and audio buffer independently; the video reaches a
//     playable frame first and starts while the audio is still buffering, so the
//     audio lags the picture for the rest of the segment. The fix is a readiness
//     GATE: neither element plays until BOTH are `canplaythrough`
//     (`readyState >= HAVE_ENOUGH_DATA`), so they start together.
//
// The decision cores here are pure functions (gate + one-shot), unit-testable
// without a DOM. The wake-lock hook is the one piece that must touch the platform
// API, kept small and defensively feature-detected.

import { useEffect, useRef } from "react";

/**
 * `HTMLMediaElement.readyState === HAVE_ENOUGH_DATA`: enough is buffered that the
 * browser estimates playback can run to the end without stalling — the level a
 * `canplaythrough` event signals. We gate the A/V start on BOTH elements reaching
 * this (not the weaker HAVE_FUTURE_DATA) so the picture and the observation begin
 * together and stay together, rather than the lighter video out-running the audio.
 */
export const HAVE_ENOUGH_DATA = 4;

/**
 * A read-only snapshot of one media element's buffering state for the start gate.
 * Mirrors only the `readyState` the gate needs, so the decision is testable
 * without a DOM. A `null` element (the ref hasn't mounted, or there is no audio
 * for this finding) reads as not-ready.
 */
export type MediaReadiness = Pick<HTMLMediaElement, "readyState"> | null;

/** Is this element buffered enough to play through (`readyState >= HAVE_ENOUGH_DATA`)? */
export function canPlayThrough(element: MediaReadiness): boolean {
  return element !== null && element.readyState >= HAVE_ENOUGH_DATA;
}

/**
 * The A/V start gate: the segment's video and audio may begin ONLY when BOTH are
 * buffered enough to play through. This is what keeps the picture and the spoken
 * observation locked together from the first frame instead of the video (lighter,
 * faster to buffer) starting early and the audio chasing it.
 *
 * Reduced motion pauses the video (the offset poster holds) but the observation
 * still plays — so under reduced motion the gate waits on the AUDIO alone; the
 * video readiness is irrelevant when it isn't going to play.
 */
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

  // Reduced motion never plays the video, so don't wait on it — the poster stands
  // in and only the audio must be ready.
  if (reducedMotion) {
    return true;
  }

  return canPlayThrough(video);
}

/**
 * Screen Wake Lock for the lean-back radio run: keep the device awake while the
 * run is playing so the screen doesn't sleep mid-observation, re-acquire when the
 * tab returns to the foreground (the OS drops the lock when the page is hidden),
 * and release the moment playback stops or the surface unmounts.
 *
 * The whole thing is feature-detected and wrapped in try/catch: older iOS Safari
 * (and any browser without the Screen Wake Lock API) simply gets no lock and the
 * run still plays — graceful degradation, never a thrown error. The lock can also
 * be revoked by the platform at any time (it fires `release`); when that happens
 * while we still want it, the next visibility change re-acquires it.
 *
 * `active` is the caller's "we are playing and want the screen awake" signal —
 * pass `started && !exhausted && playing`. Flipping it to `false` (a pause, the
 * empty-sector state, leaving the page) releases the lock.
 */
export function useScreenWakeLock(active: boolean): void {
  // The live sentinel, held across renders so visibilitychange can release/re-take
  // it. Typed loosely because `WakeLockSentinel` isn't in every lib.dom we target.
  const sentinelRef = useRef<WakeLockSentinelLike | undefined>(undefined);

  useEffect(() => {
    // Feature-detect once: no API ⇒ no-op (older iOS Safari, non-secure contexts).
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
        // `release()` resolves a promise; ignore it and any rejection — a lock the
        // platform already dropped rejects, which is harmless.
        void sentinel.release().catch(() => {});
      }
    };

    const acquire = async () => {
      // Already holding one, or we no longer want it / the tab is hidden (the OS
      // refuses a lock for a hidden document) — nothing to do.
      if (
        sentinelRef.current ||
        !active ||
        (typeof document !== "undefined" && document.visibilityState !== "visible")
      ) {
        return;
      }

      try {
        const sentinel = await wakeLock.request("screen");

        // The effect was torn down (or we stopped wanting the lock) while the
        // request was in flight — release immediately rather than leak it.
        if (cancelled || !active) {
          void sentinel.release().catch(() => {});

          return;
        }

        sentinelRef.current = sentinel;

        // The platform can revoke the lock at any time (it fires `release`); drop
        // our handle so a later visibilitychange re-acquires it.
        sentinel.addEventListener?.("release", () => {
          if (sentinelRef.current === sentinel) {
            sentinelRef.current = undefined;
          }
        });
      } catch {
        // Request denied (permissions, hidden doc, unsupported) — degrade silently.
      }
    };

    // Returning to the foreground re-acquires (the OS released it on hide); leaving
    // the foreground or stopping playback releases.
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

/** The Screen Wake Lock surface we use, narrowed so we don't depend on lib.dom's. */
type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

type WakeLockLike = {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
};
