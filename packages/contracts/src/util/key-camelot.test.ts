import { describe, expect, it } from "bun:test";

import { keyToCamelotCode, parseKey, toCamelot } from "./key-camelot";

describe("parseKey", () => {
  it("accepts scale names, shorthand, and enharmonic spellings", () => {
    const cases = [
      ["A minor", { isMinor: true, pitchClass: 9 }],
      ["F major", { isMinor: false, pitchClass: 5 }],
      ["C# major", { isMinor: false, pitchClass: 1 }],
      ["C maj", { isMinor: false, pitchClass: 0 }],
      ["a min", { isMinor: true, pitchClass: 9 }],
      ["  F major  ", { isMinor: false, pitchClass: 5 }],
      ["Bb minor", { isMinor: true, pitchClass: 10 }],
      ["Db major", { isMinor: false, pitchClass: 1 }],
      ["E♭ major", { isMinor: false, pitchClass: 3 }],
    ] as const;

    for (const [input, expected] of cases) {
      expect(parseKey(input)).toEqual(expected);
    }
  });

  it("rejects missing, unknown, and modal keys instead of guessing", () => {
    for (const input of ["", null, undefined, "unknown", "H major", "F# dorian", "174"]) {
      expect(parseKey(input)).toBeNull();
    }
  });
});

describe("Camelot projection", () => {
  it("places minor keys on the A ring and major keys on the B ring", () => {
    expect(toCamelot({ isMinor: true, pitchClass: 9 })).toEqual({ letter: "A", number: 8 });
    expect(toCamelot({ isMinor: false, pitchClass: 0 })).toEqual({ letter: "B", number: 8 });
  });

  it("converts scale text to its wheel code", () => {
    const cases = [
      ["G# minor", "1A"],
      ["D# minor", "2A"],
      ["A minor", "8A"],
      ["C major", "8B"],
      ["D# major", "5B"],
      ["F major", "7B"],
      ["Bb min", "3A"],
      ["  f# maj ", "2B"],
    ] as const;

    for (const [input, expected] of cases) {
      expect(keyToCamelotCode(input)).toBe(expected);
    }
  });

  it("returns null when scale text cannot be projected", () => {
    for (const input of ["F# dorian", "nonsense", "", null, undefined]) {
      expect(keyToCamelotCode(input)).toBeNull();
    }
  });
});
