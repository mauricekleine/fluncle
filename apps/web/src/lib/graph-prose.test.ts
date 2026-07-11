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
  labelSignatureLine,
} from "./graph-prose";

const WHEN = "2026-06-12T10:00:00.000Z";

describe("graph-prose", () => {
  it("the label line is Fluncle's own — first-found date, finding count, an invitation", () => {
    expect(labelLine(3)).toBe(
      "I pulled my first tune off Hoofbeats Music on Jun 12, 2026, and I'm up to 3 findings on this label now. Have a dig.",
    );
  });

  // "Imprint" is trade-press English, not something the uncle says out loud. It is a label, and
  // he says so — on the page's masthead AND in the hover card's count line (graph-link.tsx).
  it("never says imprint, on any entity, at any count", () => {
    const everyLine = [
      labelLine(0),
      labelLine(1),
      labelLine(7),
      labelSignatureLine("Hoofbeats Music", 1, undefined),
      labelSignatureLine("Hoofbeats Music", 7, undefined),
      albumSignatureLine("Hypnotic", 1, WHEN),
      albumSignatureLine("Hypnotic", 4, WHEN),
      albumSignatureLine("Hypnotic", 4, undefined),
      artistSignatureLine("Netsky", 4, WHEN),
    ].join(" ");

    expect(everyLine.toLowerCase()).not.toContain("imprint");
  });

  // The pluralisation bug that shipped, pinned at the boundary. "1 findings" is the classic, and
  // it reached the hover card ("1 FINDINGS OFF THIS IMPRINT"). Every count string in the app now
  // goes through `findingsCount`, so it cannot come back through a hand-rolled ternary.
  it("says '1 finding', never '1 findings'", () => {
    expect(labelSignatureLine("X", 1, undefined)).toBe(
      "One finding on this label so far. Play it loud.",
    );
    expect(albumSignatureLine("X", 1, undefined)).toBe(
      "One finding on this record so far. Play it loud.",
    );
    expect(galaxyIntroLine(1)).not.toContain("1 findings");

    for (const line of [
      labelSignatureLine("X", 2, undefined),
      albumSignatureLine("X", 2, undefined),
      galaxyIntroLine(2),
    ]) {
      expect(line).toContain("2 findings");
    }
  });

  it("counts FINDINGS only and speaks of one in the singular", () => {
    expect(labelLine(1)).toBe(
      "I pulled my first tune off Hoofbeats Music on Jun 12, 2026. Just the one so far. Play it loud.",
    );
  });

  // NOTHING FOUND YET ⇒ NO LINE. Fluncle has nothing to say about a label he has never pulled a
  // tune off, so he says NOTHING, and the masthead is just the name. These used to return
  // "Nothing logged off this one yet." — an apology for the absent half of the page, and an
  // apology is still a claim: it told a crawler the page was ABOUT findings and then had none,
  // which is exactly what made a crawler-discovered label read as a doorway page. The callers
  // render the line conditionally; a crawled label's page is simply about its tracks instead.
  it("says NOTHING about an entity Fluncle has never found anything on (no apology, no filler)", () => {
    expect(artistSignatureLine("Netsky", 0, undefined)).toBeUndefined();
    expect(albumSignatureLine("Hypnotic", 0, undefined)).toBeUndefined();
    expect(labelSignatureLine("Metalheadz", 0, undefined)).toBeUndefined();
    expect(galaxyIntroLine(0)).toBeUndefined();

    // …and the dispatcher the hover card calls agrees, so the card prints no line either.
    expect(graphSignatureLine("label", "Metalheadz", 0, undefined)).toBeUndefined();
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

  it("the album and the label are distinct voices — a record is not a label", () => {
    expect(albumSignatureLine("X", 3, WHEN)).toContain("off this record");
    expect(graphSignatureLine("label", "X", 3, WHEN)).toContain("on this label");
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

function labelLine(count: number): string | undefined {
  return graphSignatureLine("label", "Hoofbeats Music", count, WHEN);
}
