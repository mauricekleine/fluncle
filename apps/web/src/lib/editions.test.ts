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

describe("orderedGalaxies", () => {
  it("orders the known galaxies Solar → Nebular → Lunar → Astral regardless of authored order", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [{ logId: "001.0.1" }], galaxy: "Astral" },
          { findings: [{ logId: "002.0.1" }], galaxy: "Lunar" },
          { findings: [{ logId: "003.0.1" }], galaxy: "Nebular" },
          { findings: [{ logId: "004.0.1" }], galaxy: "Solar" },
        ],
      }),
    );

    expect(ordered.map((block) => block.galaxy)).toEqual(["Solar", "Nebular", "Lunar", "Astral"]);
  });

  it("matches galaxy labels case-insensitively", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [{ logId: "001.0.1" }], galaxy: "nebular" },
          { findings: [{ logId: "002.0.1" }], galaxy: "SOLAR" },
        ],
      }),
    );

    expect(ordered.map((block) => block.galaxy)).toEqual(["SOLAR", "nebular"]);
  });

  it("trails off-map labels in authored order, after the known galaxies", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [{ logId: "001.0.1" }], galaxy: "Also found" },
          { findings: [{ logId: "002.0.1" }], galaxy: "Astral" },
          { findings: [{ logId: "003.0.1" }], galaxy: "Loose ends" },
        ],
      }),
    );

    expect(ordered.map((block) => block.galaxy)).toEqual(["Astral", "Also found", "Loose ends"]);
  });

  it("drops empty blocks so a bare heading never renders", () => {
    const ordered = orderedGalaxies(
      content({
        galaxies: [
          { findings: [], galaxy: "Solar" },
          { findings: [{ logId: "001.0.1" }], galaxy: "Lunar" },
        ],
      }),
    );

    expect(ordered.map((block) => block.galaxy)).toEqual(["Lunar"]);
  });

  it("returns an empty list when there are no galaxies", () => {
    expect(orderedGalaxies(content({}))).toEqual([]);
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
