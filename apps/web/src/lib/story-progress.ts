// The per-story progress clock decision, lifted out of the Stories player so the
// gate can be reasoned about (and unit-tested) without a DOM or an animation
// frame. The player ticks this on every frame and writes the result to the
// active segment's fill; it never advances on its own.
//
// Two clocks drive a story. A finding with a playable clip runs on the CLIP's
// own clock (currentTime / duration) so the bar tracks exactly what's on screen
// and audible. A clip-less story (cover only) runs on a fixed fallback timer.
//
// The bug this gate closes: the clip's clock must not start until the clip is
// genuinely PLAYABLE. On a slow load the `<video>` element exists and may even
// know its duration (metadata is in) while no frame has played — the screen
// still shows the poster. Clocking that case ran the bar, and on a long load it
// could FINISH and auto-advance/close the story while nothing had played. So
// while a clip-bearing story is still loading we hold at 0 and report `loading`
// (the player shimmers that segment and does NOT auto-advance); the moment the
// clip is playable the clip clock takes over from 0.

import { isVideoPlayable } from "@/lib/use-video-recovery";

/** The fixed clock for a story with no playable clip (cover-only findings). */
export const FALLBACK_DURATION_MS = 8_000;

/**
 * A read-only snapshot of one story's clock inputs at a single tick. Mirrors the
 * `HTMLVideoElement` fields the gate reads, plus the fallback timer's elapsed
 * time, so the decision is pure and DOM-free.
 */
export type StoryProgressSnapshot = {
  /**
   * The active story carries a clip element. `false` for a cover-only story
   * (which always runs the fallback timer and is never `loading`).
   */
  hasClip: boolean;
  /** `HTMLMediaElement.readyState` of the clip (ignored when `hasClip` is false). */
  readyState: number;
  /** The clip's duration in seconds, or a non-finite value before metadata is in. */
  duration: number;
  /** The clip's current playhead in seconds. */
  currentTime: number;
  /** Elapsed ms on the fallback timer (for a cover-only story). */
  fallbackElapsedMs: number;
};

export type StoryProgressVerdict = {
  /** The fraction to draw on the active segment's fill, clamped to 0…1. */
  progress: number;
  /** The story has run out and the player may advance / close. */
  finished: boolean;
  /**
   * A clip-bearing story whose clip isn't playable yet — hold at 0, shimmer the
   * segment, and do NOT auto-advance. Never true for a cover-only story.
   */
  loading: boolean;
};

/**
 * Decide a clip-bearing story's clock from its clip alone — never the fallback
 * timer. A finding HAS a clip; running its fallback timer while the clip loads
 * is exactly the advance-over-a-frozen-poster bug. So until the clip is playable
 * we report `loading` (held at 0); once playable we clock `currentTime/duration`
 * (duration may still be a tick behind, hence the guard before the divide).
 */
function clipVerdict(snapshot: StoryProgressSnapshot): StoryProgressVerdict {
  if (!isVideoPlayable({ readyState: snapshot.readyState })) {
    return { finished: false, loading: true, progress: 0 };
  }

  if (!(Number.isFinite(snapshot.duration) && snapshot.duration > 0)) {
    // Playable but duration not yet finite (rare, transient): hold without
    // shimmering — it's effectively ready, just one frame early on the clock.
    return { finished: false, loading: false, progress: 0 };
  }

  const progress = Math.min(1, snapshot.currentTime / snapshot.duration);

  return { finished: progress >= 0.999, loading: false, progress };
}

/**
 * The fallback timer for a cover-only story: a fixed-duration clock, never
 * loading.
 */
function fallbackVerdict(snapshot: StoryProgressSnapshot): StoryProgressVerdict {
  const progress = Math.min(1, snapshot.fallbackElapsedMs / FALLBACK_DURATION_MS);

  return { finished: progress >= 1, loading: false, progress };
}

/**
 * The per-tick story clock decision: a clip-bearing story runs (and gates) on
 * its clip; a cover-only story runs on the fallback timer.
 */
export function storyProgress(snapshot: StoryProgressSnapshot): StoryProgressVerdict {
  return snapshot.hasClip ? clipVerdict(snapshot) : fallbackVerdict(snapshot);
}
