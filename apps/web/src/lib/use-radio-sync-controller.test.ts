import { describe, expect, it } from "vitest";
import {
  bothReadyToStart,
  canPlayThrough,
  HAVE_ENOUGH_DATA,
  radioPhaseOnReady,
} from "./use-radio-sync-controller";

const ready = { readyState: HAVE_ENOUGH_DATA };
const buffering = { readyState: 2 };
const empty = { readyState: 0 };

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

describe("radioPhaseOnReady", () => {
  it("opens the gate from tuning into playing when the stream is ready", () => {
    expect(radioPhaseOnReady("tuning")).toBe("playing");
  });

  it("is a no-op once already playing — a re-armed start mid-run never re-enters", () => {
    expect(radioPhaseOnReady("playing")).toBe("playing");
  });

  it("never jumps idle straight to playing — only a tuning gate can open", () => {
    expect(radioPhaseOnReady("idle")).toBe("idle");
  });
});
