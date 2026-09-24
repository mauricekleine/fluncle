import { describe, expect, it } from "vitest";
import { hasPreviewSource } from "./track-preview";

describe("hasPreviewSource", () => {
  it("accepts either relay source", () => {
    expect(hasPreviewSource({ previewUrl: "https://example.com/preview.mp3" })).toBe(true);
    expect(hasPreviewSource({ isrc: "GBTEST2600001" })).toBe(true);
  });

  it("treats empty and whitespace legacy values as absent", () => {
    expect(hasPreviewSource({})).toBe(false);
    expect(hasPreviewSource({ isrc: "  \t", previewUrl: "\n " })).toBe(false);
    expect(hasPreviewSource({ isrc: null, previewUrl: null })).toBe(false);
  });
});
