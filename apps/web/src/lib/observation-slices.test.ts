import { describe, expect, it } from "vitest";
import {
  activeSliceForOffset,
  type ObservationWord,
  sliceObservationWords,
} from "./observation-slices";

// The slicing + active-slice/active-word math drives the radio's center-stage
// captions (radio.tsx): it must be verifiable in isolation, not only through the
// UI. The cases that matter (per the brief): a word inside a slice; the boundary
// jump to the next slice (last word of slice N → first word of slice N+1); gaps
// between words (the last word stays lit); before the first word; after the last.

// Build words with even 100ms windows and a 50ms gap between them, so a query at
// an in-gap offset exercises the "last word stays lit" behaviour.
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
    // start indices anchor each slice to the flat list.
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
    // 14 words, no sentence end until the last; a comma sits past the 6-word
    // minimum, so the first slice breaks there rather than running long.
    const words = build(["a", "b", "c", "d", "e", "f", "g,", "h", "i", "j", "k", "l", "m", "n."]);
    const slices = sliceObservationWords(words);

    expect(slices[0]?.words.map((w) => w.text).join(" ")).toBe("a b c d e f g,");
    // Every slice stays within the 12-word cap.
    for (const slice of slices) {
      expect(slice.words.length).toBeLessThanOrEqual(12);
    }
  });

  it("hard-cuts at the max when no soft break is in range", () => {
    // 15 words, zero punctuation: must still cap at 12 so it never overflows.
    const words = build(Array.from({ length: 15 }, (_, i) => `w${i}`));
    const slices = sliceObservationWords(words);

    expect(slices[0]?.words.length).toBe(12);
    expect(slices[1]?.words.length).toBe(3);
  });

  it("does not break on a soft phrase boundary before the minimum", () => {
    // A comma at word 3 (below the 6-word min) must NOT split — only a full
    // sentence end would, and there is none until the last word.
    const words = build(["a", "b", "c,", "d", "e.", "f"]);
    const slices = sliceObservationWords(words);

    expect(slices[0]?.words.map((w) => w.text).join(" ")).toBe("a b c, d e.");
  });

  it("returns no slices for an empty word list", () => {
    expect(sliceObservationWords([])).toEqual([]);
  });
});

describe("activeSliceForOffset", () => {
  // Two clean sentences: slice 0 = [I, found, this.], slice 1 = [Out, here.].
  const words = build(["I", "found", "this.", "Out", "here."]);

  it("stages slice 0 with nothing lit before the first word", () => {
    const result = activeSliceForOffset(words, -10);

    expect(result.sliceIndex).toBe(0);
    expect(result.activeWordInSlice).toBe(-1);
    expect(result.slices).toHaveLength(2);
  });

  it("lights a word inside a slice", () => {
    // offset 160ms → word index 1 ("found"), inside slice 0 at in-slice index 1.
    const result = activeSliceForOffset(words, 160);

    expect(result.sliceIndex).toBe(0);
    expect(result.activeWordInSlice).toBe(1);
  });

  it("keeps the last word lit during a gap between words", () => {
    // offset 120ms sits in the gap after word 0 ends (100) and before word 1
    // starts (150) — word 0 stays lit, no flicker.
    const result = activeSliceForOffset(words, 120);

    expect(result.sliceIndex).toBe(0);
    expect(result.activeWordInSlice).toBe(0);
  });

  it("holds the last word of a slice, then jumps to the next slice's first word", () => {
    // Word index 2 ("this.") is slice 0's LAST word.
    const atBoundary = activeSliceForOffset(words, 300);
    expect(atBoundary.sliceIndex).toBe(0);
    expect(atBoundary.activeWordInSlice).toBe(2);

    // Word index 3 ("Out") is slice 1's FIRST word — a clean swap, in-slice 0.
    const afterBoundary = activeSliceForOffset(words, 450);
    expect(afterBoundary.sliceIndex).toBe(1);
    expect(afterBoundary.activeWordInSlice).toBe(0);
  });

  it("holds the final slice with its last word lit after the script ends", () => {
    // Past the end of word index 4 ("here.") — final slice, last word stays lit.
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
