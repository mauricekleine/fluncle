import { describe, expect, it } from "vitest";
import {
  RENDITION_LADDER,
  SMALLEST_RENDITION_WIDTH,
  stepDownRenditionWidth,
} from "./use-responsive-width";

// The ladder is walked in BOTH directions: up to the pane's rung on measure, and
// down a rung per stall (the /log watchdog's recovery — a wedged load wants FEWER
// bytes, never the heavier master). The step-down is the pure half of that, so it
// is tested here; the measuring half needs a DOM and a ResizeObserver.

describe("stepDownRenditionWidth", () => {
  it("is the identity at zero steps (the measured pane's own rung)", () => {
    for (const rung of RENDITION_LADDER) {
      expect(stepDownRenditionWidth(rung, 0)).toBe(rung);
    }
  });

  it("walks one rung down per stall — the phone's 720 pane goes 480, then 360", () => {
    expect(stepDownRenditionWidth(720, 1)).toBe(480);
    expect(stepDownRenditionWidth(720, 2)).toBe(360);
    expect(stepDownRenditionWidth(1080, 1)).toBe(720);
  });

  it("pins to the lightest rung instead of walking off the bottom", () => {
    expect(stepDownRenditionWidth(720, 3)).toBe(SMALLEST_RENDITION_WIDTH);
    expect(stepDownRenditionWidth(720, 99)).toBe(SMALLEST_RENDITION_WIDTH);
    expect(stepDownRenditionWidth(360, 1)).toBe(SMALLEST_RENDITION_WIDTH);
  });

  it("never steps UP — a negative or fractional count cannot widen the request", () => {
    expect(stepDownRenditionWidth(480, -1)).toBe(480);
    expect(stepDownRenditionWidth(480, 0.9)).toBe(480);
    expect(stepDownRenditionWidth(480, 1.9)).toBe(360);
  });

  it("never asks for a width off the ladder (every rung is a cached transform)", () => {
    for (const rung of RENDITION_LADDER) {
      for (let steps = 0; steps <= RENDITION_LADDER.length + 1; steps += 1) {
        expect(RENDITION_LADDER).toContain(stepDownRenditionWidth(rung, steps));
      }
    }
  });
});
