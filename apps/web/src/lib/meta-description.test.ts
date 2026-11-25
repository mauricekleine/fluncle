import { describe, expect, it } from "vitest";
import {
  bioMetaDescription,
  labelledMetaDescription,
  leadingSentences,
  META_DESCRIPTION_MAX,
} from "./meta-description";

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
    const bio = "word ".repeat(120).trim();

    expect(bioMetaDescription(bio).length).toBeLessThanOrEqual(160);
  });
});

describe("leadingSentences (whole bio sentences that fit a room)", () => {
  const bio = "Seba is a Swedish producer. He runs Secret Operations. He started in 1993.";

  it("takes as many whole sentences as fit", () => {
    expect(leadingSentences(bio, 60)).toBe(
      "Seba is a Swedish producer. He runs Secret Operations.",
    );
    expect(leadingSentences(bio, 200)).toBe(bio);
  });

  it("returns nothing when the first sentence does not fit", () => {
    expect(leadingSentences(bio, 10)).toBeUndefined();
  });

  it("does not split inside an abbreviation followed by lowercase", () => {
    expect(leadingSentences("Born in St. louis area. Plays jungle.", 200)).toBe(
      "Born in St. louis area. Plays jungle.",
    );
    expect(leadingSentences("Born in St. louis area. Plays jungle.", 25)).toBe(
      "Born in St. louis area.",
    );
  });

  it("does not split after initials or a short title followed by a capital", () => {
    expect(leadingSentences("M.C. Fats was a British vocalist. He hosted sets.", 40)).toBe(
      "M.C. Fats was a British vocalist.",
    );
    expect(leadingSentences("Raised in St. Albans, he plays jungle. He DJs.", 40)).toBe(
      "Raised in St. Albans, he plays jungle.",
    );
    expect(leadingSentences("M.C. Fats was a British vocalist.", 10)).toBeUndefined();
  });

  it("refuses a bio that ends mid-sentence", () => {
    expect(leadingSentences("A producer from Leeds", 200)).toBeUndefined();
  });
});

describe("labelledMetaDescription (a fixed label plus a subject cut to the snippet budget)", () => {
  const LABEL = "Fluncle drum & bass mixtape: ";

  it("returns the label, the whitespace-collapsed subject and a full stop when it fits", () => {
    expect(labelledMetaDescription(LABEL, "  Night   bus \n home  ")).toBe(
      "Fluncle drum & bass mixtape: Night bus home.",
    );
  });

  it("keeps a line of exactly the budget verbatim", () => {
    const subject = "a".repeat(META_DESCRIPTION_MAX - LABEL.length - 1);
    const line = labelledMetaDescription(LABEL, subject);

    expect(line).toBe(`${LABEL}${subject}.`);
    expect(line).toHaveLength(META_DESCRIPTION_MAX);
  });

  it("cuts one character over the budget to the budget, ending on an ellipsis", () => {
    const line = labelledMetaDescription(LABEL, "a".repeat(META_DESCRIPTION_MAX - LABEL.length));

    expect(line).toHaveLength(META_DESCRIPTION_MAX);
    expect(line.startsWith(LABEL)).toBe(true);
    expect(line.endsWith("a…")).toBe(true);
  });

  it("cuts a long subject at its last whole word", () => {
    const line = labelledMetaDescription(LABEL, "rollers ".repeat(30));

    expect(line).toBe(`${LABEL}${Array.from({ length: 16 }, () => "rollers").join(" ")}…`);
    expect(line.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });

  it.each([", ", " — "])(
    "drops the punctuation a word cut leaves before the ellipsis (%j)",
    (separator) => {
      const line = labelledMetaDescription(
        LABEL,
        `${"x".repeat(100)} ${"y".repeat(20)}${separator}${"z".repeat(50)}`,
      );

      expect(line).toBe(`${LABEL}${"x".repeat(100)} ${"y".repeat(20)}…`);
    },
  );

  it("hard-cuts a subject whose only space falls in the first half of the room", () => {
    const line = labelledMetaDescription(LABEL, `ab ${"z".repeat(200)}`);

    expect(line).toHaveLength(META_DESCRIPTION_MAX);
    expect(line.startsWith(`${LABEL}ab zzz`)).toBe(true);
    expect(line.endsWith("z…")).toBe(true);
  });

  it("never splits a character that takes two UTF-16 units", () => {
    const line = labelledMetaDescription(LABEL, "🌌".repeat(80));

    expect(line.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(line).toBe(`${LABEL}${"🌌".repeat(65)}…`);
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});
