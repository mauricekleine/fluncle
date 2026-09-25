import { describe, expect, it } from "vitest";
import {
  activeSliceForOffset,
  type ObservationWord,
  sliceObservationWords,
} from "./observation-slices";

function build(texts: string[]): ObservationWord[] {
  return texts.map((text, i) => ({
    endMs: i * 150 + 100,
    startMs: i * 150,
    text,
  }));
}

describe("sliceObservationWords", () => {
  it("splits on sentence-terminal punctuation", () => {
    const words = build(["I", "found", "this.", "Out", "here.", "Quiet."]);
    const slices = sliceObservationWords(words);

    expect(slices.map((s) => s.words.map((w) => w.text).join(" "))).toEqual([
      "I found this.",
      "Out here.",
      "Quiet.",
    ]);

    expect(slices.map((s) => s.start)).toEqual([0, 3, 5]);
  });

  it("handles quoted/bracketed sentence terminals", () => {
    const words = build(["he", 'said."', "then", "left?"]);
    const slices = sliceObservationWords(words);

    expect(slices.map((s) => s.words.map((w) => w.text).join(" "))).toEqual([
      'he said."',
      "then left?",
    ]);
  });

  it("chunks a long sentence into bounded phrase windows on a soft break", () => {
    const words = build(["a", "b", "c", "d", "e", "f", "g,", "h", "i", "j", "k", "l", "m", "n."]);
    const slices = sliceObservationWords(words);

    expect(slices[0]?.words.map((w) => w.text).join(" ")).toBe("a b c d e f g,");

    for (const slice of slices) {
      expect(slice.words.length).toBeLessThanOrEqual(12);
    }
  });

  it("hard-cuts at the max when no soft break is in range", () => {
    const words = build(Array.from({ length: 15 }, (_, i) => `w${i}`));
    const slices = sliceObservationWords(words);

    expect(slices[0]?.words.length).toBe(12);
    expect(slices[1]?.words.length).toBe(3);
  });

  it("does not treat a bare hyphen as a phrase break (compound word)", () => {
    const words = build(["a", "b", "c", "d", "e", "drum-", "and", "bass."]);
    const slices = sliceObservationWords(words);

    expect(slices).toHaveLength(1);
    expect(slices[0]?.words.map((w) => w.text).join(" ")).toBe("a b c d e drum- and bass.");
  });

  it("breaks on an em-dash phrase boundary past the minimum", () => {
    const words = build(["a", "b", "c", "d", "e", "f—", "g", "h."]);
    const slices = sliceObservationWords(words);

    expect(slices[0]?.words.map((w) => w.text).join(" ")).toBe("a b c d e f—");
  });

  it("does not break on a soft phrase boundary before the minimum", () => {
    const words = build(["a", "b", "c,", "d", "e.", "f"]);
    const slices = sliceObservationWords(words);

    expect(slices[0]?.words.map((w) => w.text).join(" ")).toBe("a b c, d e.");
  });

  it("returns no slices for an empty word list", () => {
    expect(sliceObservationWords([])).toEqual([]);
  });
});

describe("activeSliceForOffset", () => {
  const words = build(["I", "found", "this.", "Out", "here."]);

  it("stages slice 0 with nothing lit before the first word", () => {
    const result = activeSliceForOffset(words, -10);

    expect(result.sliceIndex).toBe(0);
    expect(result.activeWordInSlice).toBe(-1);
    expect(result.slices).toHaveLength(2);
  });

  it("lights a word inside a slice", () => {
    const result = activeSliceForOffset(words, 160);

    expect(result.sliceIndex).toBe(0);
    expect(result.activeWordInSlice).toBe(1);
  });

  it("keeps the last word lit during a gap between words", () => {
    const result = activeSliceForOffset(words, 120);

    expect(result.sliceIndex).toBe(0);
    expect(result.activeWordInSlice).toBe(0);
  });

  it("holds the last word of a slice, then jumps to the next slice's first word", () => {
    const atBoundary = activeSliceForOffset(words, 300);
    expect(atBoundary.sliceIndex).toBe(0);
    expect(atBoundary.activeWordInSlice).toBe(2);

    const afterBoundary = activeSliceForOffset(words, 450);
    expect(afterBoundary.sliceIndex).toBe(1);
    expect(afterBoundary.activeWordInSlice).toBe(0);
  });

  it("holds the final slice with its last word lit after the script ends", () => {
    const result = activeSliceForOffset(words, 10_000);

    expect(result.sliceIndex).toBe(1);
    expect(result.activeWordInSlice).toBe(1);
  });

  it("returns an empty, staged result for no words", () => {
    const result = activeSliceForOffset([], 500);

    expect(result.slices).toEqual([]);
    expect(result.sliceIndex).toBe(0);
    expect(result.activeWordInSlice).toBe(-1);
  });
});
