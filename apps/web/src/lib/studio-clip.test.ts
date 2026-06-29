import { describe, expect, it } from "vitest";
import {
  bandToWindow,
  centredCropLeftFraction,
  clampCropLeftFraction,
  clipToRegion,
  cropRectToXOffset,
  cropWidthFraction,
  cropWindowWidthPx,
  defaultBandAt,
  fractionToMs,
  maxXOffset,
  msToFraction,
  suggestionToRegion,
  xOffsetToLeftFraction,
} from "./studio-clip";

// The editor's pure geometry — no DOM, no ffmpeg, synthetic inputs only (the way
// the scrubber's pointer maths + the stall verdict are tested). A 1080p landscape
// set rendition is 1920×1080; a 9:16 window off it is round(1080·9/16)=608 px wide,
// leaving 1920−608=1312 px of horizontal travel for the framing xOffset.
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const CROP_W = 608;
const MAX_X = VIDEO_WIDTH - CROP_W; // 1312

describe("crop geometry", () => {
  it("derives the 9:16 window width and travel off the landscape source", () => {
    expect(cropWindowWidthPx(VIDEO_HEIGHT)).toBe(CROP_W);
    expect(maxXOffset(VIDEO_WIDTH, VIDEO_HEIGHT)).toBe(MAX_X);
  });

  it("clamps the travel to 0 for a source already 9:16 or narrower", () => {
    // A square-ish source where a 9:16 window is wider than the frame: no slide.
    expect(maxXOffset(400, 1080)).toBe(0);
  });

  it("reports the rect width as a fraction of the preview", () => {
    expect(cropWidthFraction(VIDEO_WIDTH, VIDEO_HEIGHT)).toBeCloseTo(CROP_W / VIDEO_WIDTH, 5);
    expect(cropWidthFraction(0, VIDEO_HEIGHT)).toBe(0);
  });

  it("maps a left-edge fraction to integer source-pixel xOffset, clamped to travel", () => {
    expect(
      cropRectToXOffset({ leftFraction: 0, videoHeight: VIDEO_HEIGHT, videoWidth: VIDEO_WIDTH }),
    ).toBe(0);
    // The far-left-anchored centre: a fraction past the max travel clamps to MAX_X.
    expect(
      cropRectToXOffset({ leftFraction: 1, videoHeight: VIDEO_HEIGHT, videoWidth: VIDEO_WIDTH }),
    ).toBe(MAX_X);
    // A quarter across → round(0.25·1920)=480, inside the travel.
    expect(
      cropRectToXOffset({ leftFraction: 0.25, videoHeight: VIDEO_HEIGHT, videoWidth: VIDEO_WIDTH }),
    ).toBe(480);
    // Always a whole pixel.
    expect(
      Number.isInteger(
        cropRectToXOffset({
          leftFraction: 0.333,
          videoHeight: VIDEO_HEIGHT,
          videoWidth: VIDEO_WIDTH,
        }),
      ),
    ).toBe(true);
  });

  it("round-trips xOffset ⇄ left-fraction within a pixel", () => {
    const xOffset = 480;
    const fraction = xOffsetToLeftFraction({ videoWidth: VIDEO_WIDTH, xOffset });
    expect(
      cropRectToXOffset({
        leftFraction: fraction,
        videoHeight: VIDEO_HEIGHT,
        videoWidth: VIDEO_WIDTH,
      }),
    ).toBe(xOffset);
  });

  it("centres the 9:16 window as the default framing", () => {
    expect(centredCropLeftFraction(VIDEO_WIDTH, VIDEO_HEIGHT)).toBeCloseTo(
      MAX_X / 2 / VIDEO_WIDTH,
      5,
    );
    // A centred xOffset is half the travel, in source px.
    const centred = centredCropLeftFraction(VIDEO_WIDTH, VIDEO_HEIGHT);
    expect(
      cropRectToXOffset({
        leftFraction: centred,
        videoHeight: VIDEO_HEIGHT,
        videoWidth: VIDEO_WIDTH,
      }),
    ).toBe(Math.round(MAX_X / 2));
    expect(centredCropLeftFraction(400, 1080)).toBe(0); // no travel
  });

  it("keeps the whole 9:16 window inside the frame while dragging", () => {
    // A drag to the far right clamps the LEFT edge to maxLeft = MAX_X / width.
    expect(clampCropLeftFraction(1, VIDEO_WIDTH, VIDEO_HEIGHT)).toBeCloseTo(MAX_X / VIDEO_WIDTH, 5);
    expect(clampCropLeftFraction(-0.5, VIDEO_WIDTH, VIDEO_HEIGHT)).toBe(0);
    expect(clampCropLeftFraction(0.5, 0, VIDEO_HEIGHT)).toBe(0);
  });
});

describe("timeline geometry", () => {
  const TOTAL = 72 * 60 * 1000; // a ~72-min set, in ms

  it("maps ms ⇄ fraction against the set duration, clamped", () => {
    expect(msToFraction(0, TOTAL)).toBe(0);
    expect(msToFraction(TOTAL / 2, TOTAL)).toBe(0.5);
    expect(msToFraction(TOTAL * 2, TOTAL)).toBe(1); // clamped
    expect(msToFraction(1000, 0)).toBe(0); // no duration yet
    expect(fractionToMs(0.25, TOTAL)).toBe(TOTAL * 0.25);
    expect(fractionToMs(2, TOTAL)).toBe(TOTAL); // clamped
  });

  it("turns a suggestion window into a fractional region", () => {
    const region = suggestionToRegion({ durationMs: 15_000, startMs: TOTAL / 2 }, TOTAL);
    expect(region.leftFraction).toBeCloseTo(0.5, 5);
    expect(region.widthFraction).toBeCloseTo(15_000 / TOTAL, 5);
  });

  it("turns a stored clip window into a fractional region", () => {
    const region = clipToRegion({ inMs: 60_000, outMs: 75_000 }, TOTAL);
    expect(region.leftFraction).toBeCloseTo(60_000 / TOTAL, 5);
    expect(region.widthFraction).toBeCloseTo(15_000 / TOTAL, 5);
  });

  it("sorts a hand-picked band's edges into an ordered ms window", () => {
    const forward = bandToWindow(0.25, 0.5, TOTAL);
    const backward = bandToWindow(0.5, 0.25, TOTAL);
    expect(forward).toEqual(backward); // direction-independent
    expect(forward.inMs).toBeLessThan(forward.outMs);
    expect(forward.inMs).toBe(TOTAL * 0.25);
    expect(forward.outMs).toBe(TOTAL * 0.5);
  });

  it("drops a default clip-length band at the playhead, clamped to the set end", () => {
    expect(defaultBandAt(60_000, 15_000, TOTAL)).toEqual({ inMs: 60_000, outMs: 75_000 });
    // Near the very end the start slides back so the band never overruns.
    const nearEnd = defaultBandAt(TOTAL - 1_000, 15_000, TOTAL);
    expect(nearEnd.outMs).toBe(TOTAL);
    expect(nearEnd.outMs - nearEnd.inMs).toBe(15_000);
    expect(nearEnd.inMs).toBeGreaterThanOrEqual(0);
  });
});
