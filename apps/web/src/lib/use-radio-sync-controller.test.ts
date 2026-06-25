import { describe, expect, it } from "vitest";
import { bothReadyToStart, canPlayThrough, HAVE_ENOUGH_DATA } from "./use-radio-sync-controller";

// The A/V start gate is the load-bearing fix for the radio desync: video and audio
// are two independent elements, and the gate is what holds BOTH back until each can
// play through so they start locked together (not the lighter video out-running the
// audio). The decision is a pure function, so it is tested here without a DOM.

const ready = { readyState: HAVE_ENOUGH_DATA }; // canplaythrough
const buffering = { readyState: 2 }; // HAVE_CURRENT_DATA — playable frame, not enough
const empty = { readyState: 0 }; // HAVE_NOTHING

describe("canPlayThrough", () => {
  it("is true only at HAVE_ENOUGH_DATA or above", () => {
    expect(canPlayThrough(ready)).toBe(true);
    expect(canPlayThrough({ readyState: HAVE_ENOUGH_DATA + 1 })).toBe(true);
  });

  it("is false below HAVE_ENOUGH_DATA (a playable frame is not enough to start)", () => {
    expect(canPlayThrough(buffering)).toBe(false);
    expect(canPlayThrough(empty)).toBe(false);
  });

  it("treats a null element (unmounted / no audio) as not ready", () => {
    expect(canPlayThrough(null)).toBe(false);
  });
});

describe("bothReadyToStart", () => {
  it("waits for BOTH elements when motion is allowed", () => {
    expect(bothReadyToStart({ audio: ready, reducedMotion: false, video: ready })).toBe(true);
  });

  it("holds while the audio is still buffering even if the video is ready", () => {
    expect(bothReadyToStart({ audio: buffering, reducedMotion: false, video: ready })).toBe(false);
  });

  it("holds while the video is still buffering even if the audio is ready — the desync guard", () => {
    expect(bothReadyToStart({ audio: ready, reducedMotion: false, video: buffering })).toBe(false);
  });

  it("under reduced motion waits on the audio alone (the video won't play, the poster holds)", () => {
    // Video not ready (or absent) is irrelevant when it will never play.
    expect(bothReadyToStart({ audio: ready, reducedMotion: true, video: buffering })).toBe(true);
    expect(bothReadyToStart({ audio: ready, reducedMotion: true, video: null })).toBe(true);
  });

  it("under reduced motion still holds until the audio can play through", () => {
    expect(bothReadyToStart({ audio: buffering, reducedMotion: true, video: ready })).toBe(false);
  });

  it("holds when the audio element is absent (no observation mounted yet)", () => {
    expect(bothReadyToStart({ audio: null, reducedMotion: false, video: ready })).toBe(false);
  });
});
