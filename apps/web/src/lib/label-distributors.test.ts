import { describe, expect, it } from "vitest";
import { DISTRIBUTOR_DENYLIST, isDistributorLabel } from "./label-distributors";

describe("isDistributorLabel", () => {
  it("matches every denylisted distributor by its own spelling", () => {
    for (const name of DISTRIBUTOR_DENYLIST) {
      expect(isDistributorLabel(name), name).toBe(true);
    }
  });

  it("matches across case, punctuation, spacing, and diacritics", () => {
    expect(isDistributorLabel("THE ORCHARD")).toBe(true);
    expect(isDistributorLabel("the-orchard")).toBe(true);
    expect(isDistributorLabel("  Kontor  New   Media ")).toBe(true);
    expect(isDistributorLabel("A.D.A.")).toBe(true);
    expect(isDistributorLabel("Believé")).toBe(true);
  });

  it("leaves real labels alone, including ones that merely contain a distributor's name", () => {
    expect(isDistributorLabel("Hospital Records")).toBe(false);
    expect(isDistributorLabel("Shogun Audio")).toBe(false);
    expect(isDistributorLabel("Fugazi")).toBe(false);
    expect(isDistributorLabel("Adamant")).toBe(false);
  });

  it("treats a missing or empty label as not a distributor", () => {
    expect(isDistributorLabel(null)).toBe(false);
    expect(isDistributorLabel(undefined)).toBe(false);
    expect(isDistributorLabel("")).toBe(false);
    expect(isDistributorLabel("   ")).toBe(false);
  });
});
