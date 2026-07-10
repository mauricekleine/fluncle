import { describe, expect, it } from "vitest";
import {
  type EditionDTO,
  editionFindingCount,
  editionIntroSnippet,
  orderedGalaxies,
  rowToEdition,
} from "./editions";

// The presentation helpers the /newsletter archive + back-issue pages render
// with. Pure functions over the stored content payload, so they're unit-testable
// without a React harness (the same pattern as galaxies.test.ts).

function content(partial: EditionDTO["content"]): EditionDTO["content"] {
  return partial;
}

// The section matcher now ranks against the LIVE sonic map (browse-by-feel RFC) —
// the operator-named galaxies in their public list order, passed in by the caller
// (fetched from `listGalaxyNames`), not the four dead vibe constants.
describe("orderedGalaxies", () => {
  // A stand-in live map — the operator-named galaxies in their public list order.
  const LIVE = ["The Liquid Deep", "The Feral Steppers", "Drifting Aurora"];

  it("orders the known galaxies by the live map order regardless of authored order", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [{ logId: "001.0.1" }], galaxy: "Drifting Aurora" },
          { findings: [{ logId: "002.0.1" }], galaxy: "The Feral Steppers" },
          { findings: [{ logId: "003.0.1" }], galaxy: "The Liquid Deep" },
        ],
      }),
      LIVE,
    );

    expect(ordered.map((block) => block.galaxy)).toEqual([
      "The Liquid Deep",
      "The Feral Steppers",
      "Drifting Aurora",
    ]);
  });

  it("matches galaxy labels case-insensitively against the live names", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [{ logId: "001.0.1" }], galaxy: "the feral steppers" },
          { findings: [{ logId: "002.0.1" }], galaxy: "THE LIQUID DEEP" },
        ],
      }),
      LIVE,
    );

    expect(ordered.map((block) => block.galaxy)).toEqual(["THE LIQUID DEEP", "the feral steppers"]);
  });

  it("trails off-map labels in authored order, after the known galaxies", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [{ logId: "001.0.1" }], galaxy: "Also found" },
          { findings: [{ logId: "002.0.1" }], galaxy: "Drifting Aurora" },
          { findings: [{ logId: "003.0.1" }], galaxy: "Loose ends" },
        ],
      }),
      LIVE,
    );

    expect(ordered.map((block) => block.galaxy)).toEqual([
      "Drifting Aurora",
      "Also found",
      "Loose ends",
    ]);
  });

  it("preserves authored order when the live map is empty (no galaxy named yet)", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [{ logId: "001.0.1" }], galaxy: "Drifting Aurora" },
          { findings: [{ logId: "002.0.1" }], galaxy: "The Liquid Deep" },
        ],
      }),
      [],
    );

    expect(ordered.map((block) => block.galaxy)).toEqual(["Drifting Aurora", "The Liquid Deep"]);
  });

  it("drops empty blocks so a bare heading never renders", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [], galaxy: "The Liquid Deep" },
          { findings: [{ logId: "001.0.1" }], galaxy: "The Feral Steppers" },
        ],
      }),
      LIVE,
    );

    expect(ordered.map((block) => block.galaxy)).toEqual(["The Feral Steppers"]);
  });

  it("returns an empty list when there are no galaxies", () => {
    expect(orderedGalaxies(content({}), LIVE)).toEqual([]);
  });
});

describe("editionIntroSnippet", () => {
  it("returns the intro unchanged when it's within the limit", () => {
    expect(editionIntroSnippet(content({ intro: "A quiet week." }))).toBe("A quiet week.");
  });

  it("collapses whitespace and trims to a word boundary with an ellipsis", () => {
    const snippet = editionIntroSnippet(
      content({ intro: "  one   two three four five six seven eight nine ten  " }),
      20,
    );

    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).not.toContain("  ");
    expect(snippet.length).toBeLessThanOrEqual(21);
  });

  it("returns an empty string for a missing or blank intro", () => {
    expect(editionIntroSnippet(content({}))).toBe("");
    expect(editionIntroSnippet(content({ intro: "   " }))).toBe("");
  });
});

describe("editionFindingCount", () => {
  it("sums findings across galaxy blocks", () => {
    expect(
      editionFindingCount(
        content({
          galaxies: [
            { findings: [{ logId: "001.0.1" }, { logId: "002.0.1" }], galaxy: "Solar" },
            { findings: [{ logId: "003.0.1" }], galaxy: "Lunar" },
          ],
        }),
      ),
    ).toBe(3);
  });

  it("is zero with no galaxies", () => {
    expect(editionFindingCount(content({}))).toBe(0);
  });
});

describe("rowToEdition (defensive content parse)", () => {
  it("degrades a malformed payload to an empty body rather than throwing", () => {
    const edition = rowToEdition({
      content_json: "{ not json",
      id: "abc",
      number: 3,
      sent_at: "2026-06-19T00:00:00.000Z",
      status: "sent",
      subject: "Three finds and a tape",
    });

    expect(edition.content).toEqual({});
    expect(edition.number).toBe(3);
    expect(edition.status).toBe("sent");
  });
});
