import { describe, expect, it } from "vitest";
import { formatClock, pointerFraction } from "./mixtape-video-player";

// The scrubber's pure pointer→time mapping (the VibeMap model): a pointer x over
// a track rect → a 0..1 fraction → seconds against the set duration. Unit-tested
// here without a DOM, the same way the stall watchdog's verdict is tested.
describe("pointerFraction", () => {
  const left = 100;
  const width = 400;

  it("maps the left edge to 0 and the right edge to 1", () => {
    expect(pointerFraction(left, left, width)).toBe(0);
    expect(pointerFraction(left + width, left, width)).toBe(1);
  });

  it("maps the midpoint to 0.5", () => {
    expect(pointerFraction(left + width / 2, left, width)).toBe(0.5);
  });

  it("clamps a pointer past either edge into 0..1", () => {
    expect(pointerFraction(left - 80, left, width)).toBe(0);
    expect(pointerFraction(left + width + 80, left, width)).toBe(1);
  });

  it("returns null for a zero/negative-width track (nothing to seek into)", () => {
    expect(pointerFraction(150, left, 0)).toBeNull();
    expect(pointerFraction(150, left, -10)).toBeNull();
  });

  it("composes fraction × duration into the seek target seconds", () => {
    // A ~72-min set; a click a quarter across seeks to ~18 min.
    const durationSeconds = 72 * 60;
    const fraction = pointerFraction(left + width * 0.25, left, width);

    expect(fraction).not.toBeNull();
    expect((fraction ?? 0) * durationSeconds).toBe(1080);
  });
});

describe("formatClock", () => {
  it("renders M:SS below the hour, zero-padded seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(75)).toBe("1:15");
  });

  it("renders H:MM:SS at or past the hour (a long set)", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(72 * 60 + 13)).toBe("1:12:13");
  });

  it("guards NaN/negative input to 0:00", () => {
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(-5)).toBe("0:00");
  });
});
