// The shared catalogue dedupe primitives — pinned directly, since the whole convergence contract
// (crawl.integration.test.ts + label-releases.test.ts) rests on the fold behaving exactly this way.

import { describe, expect, it } from "vitest";

import { foldTrackTitle } from "./catalogue-dedupe";

describe("foldTrackTitle", () => {
  it("absorbs cosmetic spelling/punctuation drift between two vendors' titles", () => {
    // Apple and MusicBrainz spell the same recording with different punctuation/casing.
    expect(foldTrackTitle("Foo!")).toBe(foldTrackTitle("foo"));
    expect(foldTrackTitle("Begin by Letting Go")).toBe(foldTrackTitle("begin  by letting  go"));
    expect(foldTrackTitle("Café")).toBe(foldTrackTitle("cafe"));
  });

  it("keeps a VIP / remix DISTINCT (a different title carries a distinguishing word)", () => {
    expect(foldTrackTitle("Foo")).not.toBe(foldTrackTitle("Foo VIP"));
    expect(foldTrackTitle("Weightless")).not.toBe(foldTrackTitle("Weightless (Remix)"));
  });
});
