import { describe, expect, it } from "vitest";
import {
  buildVoyageSentence,
  flyCtaVariant,
  galaxiesReached,
  type VoyagePart,
} from "./galaxy-voyage";
import { type GalaxyCompletion } from "./shared";

// Flatten the parts to the plain sentence a reader sees, so the plural/zero variants
// can be asserted as whole sentences. The renderer sets each `{ num }` in Oxanium
// tabular; here we just splice the digits back in to read the line.
function say(parts: VoyagePart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : String(part.num))).join("");
}

// The numbers the renderer will set in the tabular coordinate face, in order. These
// are the ONLY digits on the line — the Tabular Rule wants every number in Oxanium,
// and a word-form count ("once") carries no digit at all.
function nums(parts: VoyagePart[]): number[] {
  return parts.flatMap((part) => (typeof part === "string" ? [] : [part.num]));
}

const galaxy = (over: Partial<GalaxyCompletion>): GalaxyCompletion => ({
  collected: 0,
  name: "Test",
  slug: "test",
  total: 10,
  ...over,
});

describe("buildVoyageSentence", () => {
  it("reads the canonical line with everything plural", () => {
    const parts = buildVoyageSentence({ galaxies: 3, homes: 5, stars: 24, tows: 2 });

    expect(say(parts)).toBe(
      "You've logged 24 stars across 3 galaxies, flown home 5 times, and been towed 2 times.",
    );
    // Every count is a tabular number, in reading order.
    expect(nums(parts)).toEqual([24, 3, 5, 2]);
  });

  it("singularises one star in one galaxy", () => {
    const parts = buildVoyageSentence({ galaxies: 1, homes: 4, stars: 1, tows: 3 });

    expect(say(parts)).toBe(
      "You've logged 1 star across 1 galaxy, flown home 4 times, and been towed 3 times.",
    );
  });

  it("says 'once' for a single run and a single tow — no jittering digit", () => {
    const parts = buildVoyageSentence({ galaxies: 2, homes: 1, stars: 7, tows: 1 });

    expect(say(parts)).toBe(
      "You've logged 7 stars across 2 galaxies, flown home once, and been towed once.",
    );
    // "once" carries no number: only the stars and galaxies counts are tabular.
    expect(nums(parts)).toEqual([7, 2]);
  });

  it("uses 'never' for a zero run and a zero tow", () => {
    const parts = buildVoyageSentence({ galaxies: 2, homes: 0, stars: 7, tows: 0 });

    expect(say(parts)).toBe(
      "You've logged 7 stars across 2 galaxies, never flown home, and never been towed.",
    );
    expect(nums(parts)).toEqual([7, 2]);
  });

  it("opens deliberately when nothing is logged yet (runs/tows only)", () => {
    // Reachable: the door's guard opens the sentence on any of stars/wins/deaths.
    const parts = buildVoyageSentence({ galaxies: 0, homes: 1, stars: 0, tows: 0 });

    expect(say(parts)).toBe(
      "You haven't logged a star yet, flown home once, and never been towed.",
    );
    // No "0 stars across 0 galaxies" — the zero opener carries no digit.
    expect(nums(parts)).toEqual([]);
  });

  it("never emits an em dash", () => {
    const line = say(buildVoyageSentence({ galaxies: 4, homes: 9, stars: 40, tows: 12 }));

    expect(line).not.toContain("—");
  });
});

describe("galaxiesReached", () => {
  it("counts only named galaxies with at least one logged", () => {
    expect(
      galaxiesReached(
        [galaxy({ collected: 3 }), galaxy({ collected: 0 }), galaxy({ collected: 1 })],
        0,
      ),
    ).toBe(2);
  });

  it("counts the ungrouped bucket once when it holds anything", () => {
    expect(galaxiesReached([galaxy({ collected: 2 })], 5)).toBe(2);
  });

  it("ignores an empty ungrouped bucket", () => {
    expect(galaxiesReached([galaxy({ collected: 2 })], 0)).toBe(1);
  });

  it("is zero when nothing is logged anywhere", () => {
    expect(galaxiesReached([galaxy({ collected: 0 })], 0)).toBe(0);
  });
});

describe("flyCtaVariant", () => {
  it("stays gold (default) while every galaxy is unfinished", () => {
    expect(
      flyCtaVariant([galaxy({ collected: 3, total: 10 }), galaxy({ collected: 9, total: 10 })]),
    ).toBe("default");
  });

  it("drops to outline once ANY galaxy is fully logged (One Sun)", () => {
    expect(
      flyCtaVariant([galaxy({ collected: 3, total: 10 }), galaxy({ collected: 10, total: 10 })]),
    ).toBe("outline");
  });

  it("never treats an empty galaxy (total 0) as complete", () => {
    expect(flyCtaVariant([galaxy({ collected: 0, total: 0 })])).toBe("default");
  });

  it("is gold with no galaxies at all", () => {
    expect(flyCtaVariant([])).toBe("default");
  });
});
