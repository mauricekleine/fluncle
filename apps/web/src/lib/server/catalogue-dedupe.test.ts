import { describe, expect, it } from "vitest";

import { foldTrackTitle } from "./catalogue-dedupe";

describe("foldTrackTitle", () => {
  it("absorbs cosmetic spelling/punctuation drift between two vendors' titles", () => {
    expect(foldTrackTitle("Foo!")).toBe(foldTrackTitle("foo"));
    expect(foldTrackTitle("Begin by Letting Go")).toBe(foldTrackTitle("begin  by letting  go"));
    expect(foldTrackTitle("Café")).toBe(foldTrackTitle("cafe"));
  });

  it("keeps a VIP / remix DISTINCT (a different title carries a distinguishing word)", () => {
    expect(foldTrackTitle("Foo")).not.toBe(foldTrackTitle("Foo VIP"));
    expect(foldTrackTitle("Weightless")).not.toBe(foldTrackTitle("Weightless (Remix)"));
  });
});
