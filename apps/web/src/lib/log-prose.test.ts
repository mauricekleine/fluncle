import { describe, expect, it } from "vitest";
import {
  definitionalProse,
  definitionalProseSegments,
  GALAXY_CLAUSE_LEAD,
  LABEL_CLAUSE_LEAD,
  galaxyClauseLinkText,
  type LogProseInput,
} from "./log-prose";

// The definitional prose's galaxy clause (browse-by-feel RFC, Slice 4): the sonic
// galaxy rides the prose as its OWN segment, so the visible block links the name to
// `/galaxies/<slug>` while the JSON-LD description reads the same text plain. The mirror
// ("schema mirrors the visible prose") holds by construction — `definitionalProse` is
// the segments joined.

const base: LogProseInput = {
  addedAt: "2026-06-01T00:00:00.000Z",
  artists: ["Calibre"],
  logId: "004.7.2I",
  title: "Mr Majestic",
};

describe("definitionalProse — the galaxy clause", () => {
  it("omits the galaxy clause entirely when the finding is unplaced/unnamed (the dark state)", () => {
    const segments = definitionalProseSegments(base);
    expect(segments.some((s) => s.kind === "galaxy")).toBe(false);
    expect(definitionalProse(base)).not.toContain(" galaxy");
  });

  it("weaves a galaxy segment carrying the entity when the finding is placed AND named", () => {
    const segments = definitionalProseSegments({
      ...base,
      galaxy: { name: "The Liquid Deep", slug: "the-liquid-deep" },
    });
    const galaxySegment = segments.find((s) => s.kind === "galaxy");

    expect(galaxySegment).toEqual({
      kind: "galaxy",
      name: "The Liquid Deep",
      slug: "the-liquid-deep",
    });
  });

  it("the JSON-LD string mirrors the visible clause text exactly (the same words the link carries)", () => {
    const prose = definitionalProse({
      ...base,
      galaxy: { name: "The Liquid Deep", slug: "the-liquid-deep" },
    });

    // The plain string carries the FULL clause — lead + the linked phrase + tail — so a
    // crawler reads exactly what a person sees; the link is a visible-only affordance.
    expect(prose).toContain(`${GALAXY_CLAUSE_LEAD}${galaxyClauseLinkText("The Liquid Deep")}`);
    expect(galaxyClauseLinkText("The Liquid Deep")).toBe("The Liquid Deep galaxy");
    // No dead vibe-quadrant language (energy/mood/vibe map) survives the swap.
    expect(prose).not.toMatch(/vibe map|quarter of/i);
  });

  it("definitionalProse is exactly its segments joined by a single space (the mirror invariant)", () => {
    const input = {
      ...base,
      bpm: 174,
      galaxy: { name: "Weightless Rollers", slug: "weightless-rollers" },
      note: "peak-time roller",
    };
    const joined = definitionalProseSegments(input)
      .map((segment) => {
        if (segment.kind === "galaxy") {
          return `${GALAXY_CLAUSE_LEAD}${galaxyClauseLinkText(segment.name)}, with the findings that hit the same way.`;
        }

        // The release clause is a LINKABLE segment too when the imprint has an entity page
        // (the graph-link system) — same mirror rule: the JSON-LD reads it plain.
        if (segment.kind === "label") {
          return `${LABEL_CLAUSE_LEAD}${segment.name}${segment.tail}`;
        }

        return segment.text;
      })
      .join(" ");

    expect(definitionalProse(input)).toBe(joined);
  });
});
