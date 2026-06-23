import { describe, expect, it } from "vitest";
import { FALLBACK_DURATION_MS, type StoryProgressSnapshot, storyProgress } from "./story-progress";

// The gate's load-bearing job: a clip-bearing story must NOT clock (and so must
// never finish / auto-advance) until its clip is genuinely playable. On a slow
// load the <video> exists — and may even know its duration — while no frame has
// played; clocking that ran the bar over a frozen poster and could close the
// story before anything played. So below HAVE_CURRENT_DATA the verdict holds at
// 0 and reports `loading`; at/above it, the clip's own clock takes over.

// HAVE_NOTHING(0) … HAVE_CURRENT_DATA(2) … HAVE_ENOUGH_DATA(4)
const NOTHING = 0;
const METADATA = 1;
const CURRENT = 2;
const ENOUGH = 4;

function clip(overrides: Partial<StoryProgressSnapshot> = {}): StoryProgressSnapshot {
  return {
    currentTime: 0,
    duration: 30,
    fallbackElapsedMs: 0,
    hasClip: true,
    readyState: ENOUGH,
    ...overrides,
  };
}

describe("storyProgress — clip gate", () => {
  it("holds at 0 and reports loading while the clip isn't playable yet", () => {
    expect(storyProgress(clip({ readyState: NOTHING }))).toEqual({
      finished: false,
      loading: true,
      progress: 0,
    });
  });

  it("still holds when only metadata (duration) is in but no frame has played", () => {
    // The exact field bug: duration is known, so the old code divided and ran
    // the bar — but readyState is below HAVE_CURRENT_DATA, nothing has played.
    expect(storyProgress(clip({ currentTime: 0, duration: 30, readyState: METADATA }))).toEqual({
      finished: false,
      loading: true,
      progress: 0,
    });
  });

  it("never reports finished while loading, even at a long fallback elapsed", () => {
    const verdict = storyProgress(
      clip({ fallbackElapsedMs: FALLBACK_DURATION_MS * 10, readyState: NOTHING }),
    );

    expect(verdict.finished).toBe(false);
    expect(verdict.loading).toBe(true);
    expect(verdict.progress).toBe(0);
  });

  it("clocks the clip once playable (currentTime / duration), no longer loading", () => {
    const verdict = storyProgress(clip({ currentTime: 15, duration: 30, readyState: CURRENT }));

    expect(verdict.loading).toBe(false);
    expect(verdict.progress).toBeCloseTo(0.5, 5);
    expect(verdict.finished).toBe(false);
  });

  it("finishes at the end of a playable clip", () => {
    expect(storyProgress(clip({ currentTime: 30, duration: 30, readyState: ENOUGH }))).toEqual({
      finished: true,
      loading: false,
      progress: 1,
    });
  });

  it("clamps progress to 1 if currentTime overruns duration", () => {
    expect(storyProgress(clip({ currentTime: 31, duration: 30 })).progress).toBe(1);
  });

  it("does not shimmer when playable but duration isn't finite yet (transient)", () => {
    expect(storyProgress(clip({ duration: Number.NaN, readyState: CURRENT }))).toEqual({
      finished: false,
      loading: false,
      progress: 0,
    });
  });
});

describe("storyProgress — cover-only fallback timer", () => {
  function cover(overrides: Partial<StoryProgressSnapshot> = {}): StoryProgressSnapshot {
    return {
      currentTime: 0,
      duration: Number.NaN,
      fallbackElapsedMs: 0,
      hasClip: false,
      readyState: 0,
      ...overrides,
    };
  }

  it("is never loading — a cover has no clip to wait on", () => {
    expect(storyProgress(cover()).loading).toBe(false);
  });

  it("runs the fixed fallback clock and finishes at its duration", () => {
    expect(
      storyProgress(cover({ fallbackElapsedMs: FALLBACK_DURATION_MS / 2 })).progress,
    ).toBeCloseTo(0.5, 5);
    expect(storyProgress(cover({ fallbackElapsedMs: FALLBACK_DURATION_MS })).finished).toBe(true);
  });
});
