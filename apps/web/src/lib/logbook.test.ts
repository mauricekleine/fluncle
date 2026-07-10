import { describe, expect, it } from "vitest";
import { logbookPath, parseLogbookBody, resolveLogbookFigure } from "./logbook";

// The logbook body model: the markdown-lite parser + the figure-token → poster
// resolution, the two pieces the /logbook/<sector> page renders from.

describe("parseLogbookBody", () => {
  it("turns a lone `[[logId]]` line into a figure block (the photo token)", () => {
    const blocks = parseLogbookBody("The day opened slow.\n\n[[036.7.2I]]\n\nThen it kicked.");

    expect(blocks).toEqual([
      { content: [{ text: "The day opened slow.", type: "text" }], type: "paragraph" },
      { logId: "036.7.2I", type: "figure" },
      { content: [{ text: "Then it kicked.", type: "text" }], type: "paragraph" },
    ]);
  });

  it("keeps a mixtape coordinate's F marker in the figure token", () => {
    const [block] = parseLogbookBody("[[019.F.1A]]");

    expect(block).toEqual({ logId: "019.F.1A", type: "figure" });
  });

  it("does NOT treat an inline `[[logId]]` inside prose as a figure", () => {
    const blocks = parseLogbookBody("I dropped [[036.7.2I]] halfway through.");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("paragraph");
  });

  it("parses `##`/`###` headings at their level", () => {
    const blocks = parseLogbookBody("## Morning\n\n### The low end");

    expect(blocks).toEqual([
      { content: [{ text: "Morning", type: "text" }], level: 2, type: "heading" },
      { content: [{ text: "The low end", type: "text" }], level: 3, type: "heading" },
    ]);
  });

  it("joins soft-wrapped lines into one paragraph, splits on blank lines", () => {
    const blocks = parseLogbookBody("one\ntwo\n\nthree");

    expect(blocks).toEqual([
      { content: [{ text: "one two", type: "text" }], type: "paragraph" },
      { content: [{ text: "three", type: "text" }], type: "paragraph" },
    ]);
  });

  it("parses **strong** and *em* inline emphasis, leaving plain text between", () => {
    const [block] = parseLogbookBody("a **bold** and *soft* run");

    expect(block).toEqual({
      content: [
        { text: "a ", type: "text" },
        { text: "bold", type: "strong" },
        { text: " and ", type: "text" },
        { text: "soft", type: "em" },
        { text: " run", type: "text" },
      ],
      type: "paragraph",
    });
  });

  it("leaves an unbalanced emphasis marker as literal text", () => {
    const [block] = parseLogbookBody("a *lonely star");

    expect(block).toEqual({
      content: [{ text: "a *lonely star", type: "text" }],
      type: "paragraph",
    });
  });
});

describe("resolveLogbookFigure", () => {
  const findings = { "036.7.2I": { artists: ["Fizzy", "Dj Rush"], title: "Deep Cut" } };

  it("captions a known finding `Artist — Title · <logId>` and derives its poster", () => {
    const figure = resolveLogbookFigure("036.7.2I", findings);

    expect(figure.caption).toBe("Fizzy, Dj Rush — Deep Cut · 036.7.2I");
    expect(figure.posterUrl).toBe("https://found.fluncle.com/036.7.2I/poster.jpg");
  });

  it("degrades an unknown coordinate to the bare Log ID caption (still renders)", () => {
    const figure = resolveLogbookFigure("999.0.9Z", findings);

    expect(figure.caption).toBe("999.0.9Z");
    expect(figure.posterUrl).toBe("https://found.fluncle.com/999.0.9Z/poster.jpg");
  });
});

describe("logbookPath", () => {
  it("zero-pads the sector to the /logbook/036 form", () => {
    expect(logbookPath(36)).toBe("/logbook/036");
    expect(logbookPath(1234)).toBe("/logbook/1234");
  });
});
