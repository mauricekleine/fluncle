import { describe, expect, it } from "vitest";
import { firstFoundAt, galaxyIntroLine, graphSignatureLine } from "./graph-prose";

const WHEN = "2026-06-12T10:00:00.000Z";

describe("graph-prose", () => {
  it("artist, label, and album carry NO signature line (the Three Areas Rule)", () => {
    for (const kind of ["artist", "label", "album"] as const) {
      expect(graphSignatureLine(kind, "Hoofbeats Music", 0, undefined)).toBeUndefined();
      expect(graphSignatureLine(kind, "Hoofbeats Music", 1, WHEN)).toBeUndefined();
      expect(graphSignatureLine(kind, "Hoofbeats Music", 16, WHEN)).toBeUndefined();
      expect(graphSignatureLine(kind, "Hoofbeats Music", 7, undefined)).toBeUndefined();
    }
  });

  it("the galaxy line survives — lore keeps its voice", () => {
    expect(graphSignatureLine("galaxy", "Kalyx", 5, WHEN)).toBe(galaxyIntroLine(5));
    expect(galaxyIntroLine(9)).toBe("9 findings that hit the same way, core of the galaxy first.");
    expect(galaxyIntroLine(1)).toBe(
      "One finding out here so far, and everything near it in sound.",
    );
  });

  it("says NOTHING about an empty galaxy (no apology, no filler)", () => {
    expect(galaxyIntroLine(0)).toBeUndefined();
    expect(graphSignatureLine("galaxy", "Kalyx", 0, undefined)).toBeUndefined();
  });

  it("says '1 finding', never '1 findings'", () => {
    expect(galaxyIntroLine(1)).not.toContain("1 findings");
    expect(galaxyIntroLine(2)).toContain("2 findings");
  });

  it("never says imprint in the surviving line", () => {
    expect(`${galaxyIntroLine(1)} ${galaxyIntroLine(7)}`.toLowerCase()).not.toContain("imprint");
  });

  describe("firstFoundAt", () => {
    it("is the EARLIEST finding, not the freshest", () => {
      expect(
        firstFoundAt([
          { addedAt: "2026-07-01T00:00:00.000Z" },
          { addedAt: "2026-06-12T00:00:00.000Z" },
          { addedAt: "2026-06-30T00:00:00.000Z" },
        ]),
      ).toBe("2026-06-12T00:00:00.000Z");
    });

    it("is undefined when nothing carries a date", () => {
      expect(firstFoundAt([{}, {}])).toBeUndefined();
      expect(firstFoundAt([])).toBeUndefined();
    });
  });
});
