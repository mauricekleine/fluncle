import { describe, expect, it } from "vitest";
import { bioMetaDescription } from "./meta-description";

describe("bioMetaDescription (the entity bio → ≤160 meta description trim)", () => {
  it("returns a bio already within the cap verbatim, with no ellipsis", () => {
    const bio = "Jake Shepherd is an Australian drum and bass producer and DJ.";

    expect(bio.length).toBeLessThanOrEqual(160);
    expect(bioMetaDescription(bio)).toBe(bio);
    expect(bioMetaDescription(bio)).not.toContain("…");
  });

  it("ends on a complete sentence when one lands within the cap (no ellipsis)", () => {
    const bio =
      "Jake Shepherd is an Australian drum and bass producer and DJ whose sound moves between " +
      "melodic liquid rollers and high-energy dancefloor drum and bass. He runs his own label " +
      "and tours internationally.";

    const result = bioMetaDescription(bio);

    expect(bio.length).toBeGreaterThan(160);
    expect(result.length).toBeLessThanOrEqual(160);
    // A clean full first sentence, terminator kept, no ellipsis and no bleed into sentence two.
    expect(result.endsWith("dancefloor drum and bass.")).toBe(true);
    expect(result).not.toContain("…");
    expect(result).not.toContain("He runs");
  });

  it("cuts at the last whole word with an ellipsis when no sentence boundary fits", () => {
    const bio =
      "Nu:Tone is a British drum and bass producer and multi-instrumentalist known across two " +
      "decades of liquid rollers releases collaborations and remixes on Hospital Records and " +
      "far beyond the scene";

    const result = bioMetaDescription(bio);
    const head = result.slice(0, -1);

    expect(bio.length).toBeGreaterThan(160);
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result.endsWith("…")).toBe(true);
    // No mid-word cut: the head is a whole-word prefix of the bio (the next char is whitespace),
    // and the char before the ellipsis is never a space.
    expect(bio.startsWith(head)).toBe(true);
    expect(/\s/u.test(bio.charAt(head.length))).toBe(true);
    expect(/\S…$/u.test(result)).toBe(true);
  });

  it("collapses an authored paragraph's whitespace to single spaces (one meta line)", () => {
    const result = bioMetaDescription("Line one.\n\nLine two.\tLine three.");

    expect(result).toBe("Line one. Line two. Line three.");
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\t");
  });

  it("keeps the FINAL string (ellipsis included) within the cap for a maximal bio", () => {
    const bio = "word ".repeat(120).trim(); // ~600 chars, no sentence boundary at all

    expect(bioMetaDescription(bio).length).toBeLessThanOrEqual(160);
  });
});
