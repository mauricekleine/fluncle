// A shared stall/error watchdog for the full-screen `<video>` surfaces (Stories,
// /log footage, radio). Both surfaces request a Cloudflare Media Transformations
// rendition off the master (see lib/media.ts); a rendition can cold-MISS, 404, or
// simply STALL at the edge. The existing recovery was a one-shot `onError`, but a
// STUCK LOAD is the failure that bites in the field: a video that never starts
// fires `stalled`/`waiting` (or just never advances `readyState`) and NEVER an
// `error` event — so the `onError` fallback never runs and the clip hangs on its
// poster forever.
//
// This watchdog closes that gap. It watches the element's load PROGRESS and, when
// a load is wedged past a threshold (a lingering stall, or no `readyState` gain
// within a window) while the element is meant to be playing, it fires a single
// recovery step. The recovery itself is the caller's job (retry the load, then
// fall back to the raw master, optionally cache-bust) — this hook only decides
// WHEN a load is stuck, so the decision can be unit-tested without a DOM.
//
// The decision core (`mediaStallVerdict`) is a pure function; the hook
// (`useVideoStallRecovery`) wires DOM media events + a ticking timer to it.

import { type RefObject, useEffect, useRef } from "react";

/** The element has at least the current frame and enough to start playing. */
export const HAVE_CURRENT_DATA = 2;

/**
 * Is this `<video>` genuinely playable yet — does it hold at least the current
 * frame (`readyState >= HAVE_CURRENT_DATA`, i.e. a `canplay`/`playing` has
 * fired)? Below this the element is still loading: it shows its poster, nothing
 * has played, and any clock driven off it would advance over a frozen screen.
 * Shared so the stall watchdog and the Stories progress gate read "playable" the
 * same way. A null element (a cover-only story with no clip) is not a video, so
 * this is irrelevant to it — callers gate on the element's presence first.
 */
export function isVideoPlayable(video: Pick<HTMLVideoElement, "readyState"> | null): boolean {
  return video !== null && video.readyState >= HAVE_CURRENT_DATA;
}

/**
 * No progress within this window (and not yet playable) counts as wedged. Long
 * enough that an ordinary cold-MISS transcode on a phone over cellular isn't
 * mistaken for a stall; short enough that a genuinely stuck clip self-heals well
 * before a viewer gives up and leaves.
 */
export const STALL_TIMEOUT_MS = 6_000;

/**
 * A `stalled`/`waiting` event that's still standing this long after it fired is
 * treated as wedged even if the watchdog tick hasn't crossed the full
 * STALL_TIMEOUT_MS — the element told us it's starved, so we react sooner.
 */
export const STALL_EVENT_GRACE_MS = 3_000;

/** The poll cadence for the wedge check — cheap, and well under the timeout. */
export const STALL_TICK_MS = 1_000;

/**
 * The most recoveries the watchdog will fire across a single effect instance
 * (one source / `expectsPlayback` lifetime). The latch re-arms after each
 * recovery (see `recoveryLatchDecision`), so without a cap a genuinely dead
 * source — where every recovery is a no-op that swaps no `src` and never reaches
 * `HAVE_CURRENT_DATA` — would re-wedge, re-arm, and recover on a tight loop,
 * hammering `load()`/`resolveSlot()` forever. This caps the bounded retry: after
 * this many attempts the watchdog stands down for the rest of the episode. Low
 * enough to never thrash a dead edge; high enough to cover a couple of cold
 * misses on the same finding (the field repro is two wedges on one slot).
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * A read-only snapshot of a media element's load health at one instant. Mirrors
 * the `HTMLMediaElement` fields the verdict needs, so the decision is testable
 * without a DOM.
 */
export type MediaStallSnapshot = {
  /** `HTMLMediaElement.readyState` (0…4). < HAVE_CURRENT_DATA = not yet playable. */
  readyState: number;
  /** Ms since the current source began loading (reset on every `src` change). */
  msSinceLoadStart: number;
  /** Ms since `readyState` last increased, or since load start if it never has. */
  msSinceLastProgress: number;
  /**
   * Ms since a `stalled`/`waiting` event last fired while still not playable, or
   * `undefined` if none is outstanding (a later `playing`/`canplay` clears it).
   */
  msSinceStallEvent: number | undefined;
  /** The element is supposed to be loading/playing (not intentionally paused/idle). */
  expectsPlayback: boolean;
};

/**
 * Decide whether a load is wedged and should be recovered.
 *
 * Returns `true` only when the element is meant to be playing, is NOT yet
 * playable (`readyState` < HAVE_CURRENT_DATA — once it can play, a later buffer
 * stall is the browser's own rebuffering, not our concern), and EITHER it has
 * made no `readyState` progress for STALL_TIMEOUT_MS, OR a `stalled`/`waiting`
 * event has been outstanding past STALL_EVENT_GRACE_MS. A playable element, an
 * idle element, or one still inside its grace window is left alone.
 */
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

/**
 * A read-only snapshot of the recovery latch at one tick: whether a recovery has
 * already fired and is still standing, how long ago it fired, whether the element
 * has since reached a playable frame, and how many recoveries have fired so far.
 * Mirrors only what the latch decision needs, so it is testable without a DOM.
 */
export type RecoveryLatchSnapshot = {
  /** A recovery has fired and the latch has not yet re-armed. */
  recovered: boolean;
  /** Ms since the last recovery fired (meaningful only while `recovered`). */
  msSinceRecovery: number;
  /** The element holds at least the current frame now (`readyState >= HAVE_CURRENT_DATA`). */
  isPlayable: boolean;
  /** How many recoveries have fired across this episode so far. */
  attempts: number;
};

/** What the watchdog tick should do with the recovery latch this cycle. */
export type RecoveryLatchAction =
  /** Latch is dead this tick — skip the wedge check entirely. */
  | "hold"
  /** Latch should re-arm (no-op recovery left `src` unchanged, or the element
   *  recovered) — clear it and let the wedge check run again. */
  | "rearm"
  /** Latch is open — run the wedge check normally. */
  | "open";

/**
 * Decide what a watchdog tick should do with the one-recovery-per-episode latch.
 *
 * The latch exists so each stuck load gets exactly one recovery, never a tight
 * retry loop. The original latch re-armed ONLY when a fresh `loadstart`/`emptied`
 * fired — i.e. only when the caller's recovery swapped `src`. Radio's second-wedge
 * recovery (`resolveSlot()`) commonly resolves to the SAME `videoUrl`, swaps no
 * `src`, fires no `loadstart`, and so the latch stayed dead forever, leaving a
 * later stall on that clip with no recovery path.
 *
 * This re-arms the latch defensively without depending on a fresh load event:
 * once a recovery has fired, the next tick may re-arm it if EITHER the element
 * actually made it to a playable frame since (a real recovery — let a future
 * distinct wedge recover too) OR a bounded re-arm window has elapsed (a no-op
 * recovery that swapped no `src` is not permanently latched). The whole thing is
 * capped at `MAX_RECOVERY_ATTEMPTS` so a genuinely dead source cannot tight-loop.
 */
export function recoveryLatchDecision(snapshot: RecoveryLatchSnapshot): RecoveryLatchAction {
  // The bounded retry is exhausted: a dead source stands down for good. Checked
  // first so a hard-dead clip can never re-arm past the cap.
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

/**
 * Attach the stall/error watchdog to a `<video>` ref and fire `onStall` ONCE per
 * wedge episode.
 *
 * It tracks the current source's load-start, last-`readyState`-progress, and
 * last-`stalled`/`waiting` timestamps, polls `mediaStallVerdict` on a cheap tick,
 * and calls `onStall` the first time the load is judged wedged. The episode latch
 * re-arms when the element resets to a fresh load (`loadstart` / `emptied`), when
 * it reaches a playable frame, OR after a bounded window — so a recovery that
 * swaps no `src` (radio's `resolveSlot()` resolving to the same slot) is not
 * permanently latched (see `recoveryLatchDecision`). A `MAX_RECOVERY_ATTEMPTS` cap
 * keeps a genuinely dead source from tight-looping recoveries.
 *
 * `expectsPlayback` gates the whole watchdog: when the element is intentionally
 * idle (off-screen, reduced-motion hold, paused) there's no load to be stuck, so
 * pass `false` and nothing fires. `src` is taken so the latch and timers reset
 * cleanly on every source change; `onStall` is read through a ref so a fresh
 * closure each render doesn't re-arm the listeners.
 */
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
    // Latch: one recovery per wedge episode. Re-armed by a fresh load, by the
    // element reaching a playable frame, or after a bounded window (so a no-op
    // recovery that swapped no `src` isn't permanently latched), capped at
    // MAX_RECOVERY_ATTEMPTS so a dead source can't tight-loop. See
    // `recoveryLatchDecision`.
    let recovered = false;
    let recoveredAt = 0;
    let attempts = 0;

    const markProgress = () => {
      lastProgressAt = now();
      stallEventAt = undefined;
    };

    // A NEW load began (src swap, or the element re-armed): reset every clock and
    // the latch so this fresh attempt gets its own full timeout + one recovery.
    const onLoadStart = () => {
      loadStartAt = now();
      lastProgressAt = loadStartAt;
      lastReadyState = video.readyState;
      stallEventAt = undefined;
      // A genuinely fresh load is a new episode: clear the latch AND the bounded
      // attempt budget so the new source gets its own full retry allowance.
      recovered = false;
      recoveredAt = 0;
      attempts = 0;
    };

    // readyState climbing = real load progress; clears any outstanding stall.
    const onReadyProgress = () => {
      if (video.readyState > lastReadyState) {
        lastReadyState = video.readyState;
        markProgress();
      }
    };

    // The element told us it's starved while not yet playable; start the grace
    // clock (a later `playing`/`canplay` clears it via markProgress).
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
      // Reflect any readyState the browser reached without a discrete event,
      // BEFORE the latch decision so a since-recovered element is seen playable.
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
