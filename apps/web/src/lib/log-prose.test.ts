import { describe, expect, it } from "vitest";
import {
  definitionalProse,
  definitionalProseSegments,
  GALAXY_CLAUSE_LEAD,
  LABEL_CLAUSE_LEAD,
  galaxyClauseLinkText,
  type LogProseInput,
  logMetaDescription,
} from "./log-prose";
import { META_DESCRIPTION_MAX } from "./meta-description";

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

    expect(prose).toContain(`${GALAXY_CLAUSE_LEAD}${galaxyClauseLinkText("The Liquid Deep")}`);
    expect(galaxyClauseLinkText("The Liquid Deep")).toBe("The Liquid Deep galaxy");

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

        if (segment.kind === "label") {
          return `${LABEL_CLAUSE_LEAD}${segment.name}${segment.tail}`;
        }

        return segment.text;
      })
      .join(" ");

    expect(definitionalProse(input)).toBe(joined);
  });
});

describe("logMetaDescription — the SERP snippet on a finding's page", () => {
  it("keeps the whole definitional line when it fits", () => {
    expect(logMetaDescription({ ...base, bpm: 174 })).toBe(
      "004.7.2I is Fluncle's Log ID for Calibre — Mr Majestic: a 174 BPM drum & bass banger found Jun 1, 2026. fluncle://004.7.2I.",
    );
  });

  it("drops the scheme coordinate, then the tempo, before it would run past the cut", () => {
    const longCredit = {
      ...base,
      artists: ["Orbit Crew", "Long Way Back Collective", "Dust Lane"],
      bpm: 174,
      title: "Lift Off (Far Side Extended Rework)",
    };
    const description = logMetaDescription(longCredit);

    expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(description).not.toContain("fluncle://");
    expect(description.endsWith("found Jun 1, 2026.")).toBe(true);
  });

  it("never runs past the cut, however long the credit", () => {
    const description = logMetaDescription({
      ...base,
      artists: Array.from({ length: 8 }, (_value, index) => `A Very Long Artist Name ${index}`),
      bpm: 174,
    });

    expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });
});
