// THE LOAD-BEARING GUARANTEE OF THE GRAPH-LINK SYSTEM: the hover card mirrors the entity page
// by construction, because both go through `graph-prose.ts`. Since the Three Areas Rule
// (DESIGN.md; VOICE.md §5, ratified 2026-07-18), that mirror has two states: the GALAXY page
// opens with its intro line (a galaxy is lore), and the three CATALOGUE kinds — artist, label,
// album — open with NO line at all (their first-person signature lines are retired; the pages
// speak through the third-person dossier bio instead). These tests pin BOTH: the surviving
// sentence itself, and the retirement — a resurrected "I'm up to N findings on this label now"
// fails here before it can reach a public page.

import { describe, expect, it } from "vitest";
import { firstFoundAt, galaxyIntroLine, graphSignatureLine } from "./graph-prose";

const WHEN = "2026-06-12T10:00:00.000Z";

describe("graph-prose", () => {
  // THE RETIREMENT. A catalogue entity carries no signature line at any count, with or without
  // a first-found date — the page masthead prints none, so the dispatcher the hover card calls
  // returns none. This is the Three Areas Rule at the code boundary.
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

  // NOTHING FOUND YET ⇒ NO LINE, for the one kind that still speaks. An empty galaxy is
  // unreachable by construction, but the builder obeys the rule all the same.
  it("says NOTHING about an empty galaxy (no apology, no filler)", () => {
    expect(galaxyIntroLine(0)).toBeUndefined();
    expect(graphSignatureLine("galaxy", "Kalyx", 0, undefined)).toBeUndefined();
  });

  // The pluralisation bug that shipped, pinned at the boundary for the surviving line.
  it("says '1 finding', never '1 findings'", () => {
    expect(galaxyIntroLine(1)).not.toContain("1 findings");
    expect(galaxyIntroLine(2)).toContain("2 findings");
  });

  // "Imprint" is trade-press English, not something the uncle says out loud (the ban predates
  // the retirement and outlives it — the hover card's count noun in graph-link.tsx is "on this
  // label" for the same reason).
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
