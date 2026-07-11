// THE LOAD-BEARING GUARANTEE OF THE GRAPH-LINK SYSTEM: the hover card's line and the entity
// page's opening line are the SAME SENTENCE. Not similar, not a summary — the same one, because
// both callers go through the builders in `graph-prose.ts`.
//
// These tests pin the sentences themselves (a drift in the voice fails here, which is what you
// want for copy that appears on a public page AND in a card that previews it), and they pin the
// dispatcher `graphSignatureLine` against each per-entity builder, so a future kind cannot be
// wired to the wrong voice.

import { describe, expect, it } from "vitest";
import {
  albumSignatureLine,
  artistSignatureLine,
  firstFoundAt,
  galaxyIntroLine,
  graphSignatureLine,
} from "./graph-prose";

const WHEN = "2026-06-12T10:00:00.000Z";

describe("graph-prose", () => {
  it("the label line is Fluncle's own — first-found date, finding count, an invitation", () => {
    expect(labelLine(3)).toBe(
      "I pulled my first tune off Hoofbeats Music on Jun 12, 2026, and I've logged 3 off the imprint since. Have a dig.",
    );
  });

  it("counts FINDINGS only and speaks of one in the singular", () => {
    expect(labelLine(1)).toBe(
      "I pulled my first tune off Hoofbeats Music on Jun 12, 2026. Just the one so far. Play it loud.",
    );
  });

  it("degrades honestly when an entity has nothing logged (no invented history)", () => {
    expect(artistSignatureLine("Netsky", 0, undefined)).toBe("Nothing logged from this one yet.");
    expect(albumSignatureLine("Hypnotic", 0, undefined)).toBe("Nothing logged off this one yet.");
    expect(galaxyIntroLine(0)).toBe("0 findings that hit the same way, core of the galaxy first.");
  });

  it("degrades to a bare count when a date is missing, never to a fabricated one", () => {
    expect(artistSignatureLine("Netsky", 4, undefined)).toBe(
      "I've found 4 of their tunes so far. Have a dig.",
    );
    expect(artistSignatureLine("Netsky", 4, undefined)).not.toMatch(/\d{4}|Jan|undefined|NaN/);
  });

  it("never names a genre or a mood claim (the Garnish Rule) in the galaxy line", () => {
    expect(galaxyIntroLine(9)).toBe("9 findings that hit the same way, core of the galaxy first.");
    expect(galaxyIntroLine(1)).toBe(
      "One finding out here so far, and everything near it in sound.",
    );
  });

  // THE MIRROR. `graphSignatureLine` is what the hover card calls; the four builders are what
  // the four pages call. They must be the same function for the same entity — otherwise the
  // card and the page it previews say different things about the same object.
  it("the card's dispatcher IS each page's builder (the card can never drift from the page)", () => {
    expect(graphSignatureLine("artist", "Netsky", 3, WHEN)).toBe(
      artistSignatureLine("Netsky", 3, WHEN),
    );
    expect(graphSignatureLine("label", "Hoofbeats Music", 3, WHEN)).toBe(labelLine(3));
    expect(graphSignatureLine("album", "Hypnotic", 2, WHEN)).toBe(
      albumSignatureLine("Hypnotic", 2, WHEN),
    );
    // The galaxy's line takes no date and no name at all — its page opens on the count alone.
    expect(graphSignatureLine("galaxy", "Kalyx", 5, WHEN)).toBe(galaxyIntroLine(5));
  });

  it("the album and the label are distinct voices — a record is not an imprint", () => {
    expect(albumSignatureLine("X", 3, WHEN)).toContain("off it since");
    expect(graphSignatureLine("label", "X", 3, WHEN)).toContain("off the imprint since");
  });

  describe("firstFoundAt", () => {
    it("is the EARLIEST finding, not the freshest (the line says 'my first tune')", () => {
      expect(
        firstFoundAt([
          { addedAt: "2026-07-01T00:00:00.000Z" },
          { addedAt: "2026-06-12T00:00:00.000Z" },
          { addedAt: "2026-06-30T00:00:00.000Z" },
        ]),
      ).toBe("2026-06-12T00:00:00.000Z");
    });

    it("is undefined when nothing carries a date (and the line then drops the clause)", () => {
      expect(firstFoundAt([{}, {}])).toBeUndefined();
      expect(firstFoundAt([])).toBeUndefined();
    });
  });
});

function labelLine(count: number): string {
  return graphSignatureLine("label", "Hoofbeats Music", count, WHEN);
}
