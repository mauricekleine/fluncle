import { describe, expect, it } from "vitest";
import { keyToCamelotCode, parseKey, toCamelot } from "./key-camelot";

describe("parseKey", () => {
  it("parses full-word scale text", () => {
    expect(parseKey("A minor")).toEqual({ isMinor: true, pitchClass: 9 });
    expect(parseKey("F major")).toEqual({ isMinor: false, pitchClass: 5 });
    expect(parseKey("C# major")).toEqual({ isMinor: false, pitchClass: 1 });
  });

  it("accepts maj/min shorthand, lowercase notes, and stray whitespace", () => {
    expect(parseKey("C maj")).toEqual({ isMinor: false, pitchClass: 0 });
    expect(parseKey("a min")).toEqual({ isMinor: true, pitchClass: 9 });
    expect(parseKey("  F major  ")).toEqual({ isMinor: false, pitchClass: 5 });
  });

  it("folds flats + Unicode accidentals to their sharp enharmonic pitch class", () => {
    expect(parseKey("Bb minor")).toEqual(parseKey("A# minor"));
    expect(parseKey("Db major")).toEqual(parseKey("C# major"));
    expect(parseKey("E♭ major")).toEqual({ isMinor: false, pitchClass: 3 });
  });

  it("returns null for junk, modal, empty, and nullish input", () => {
    expect(parseKey("")).toBeNull();
    expect(parseKey(null)).toBeNull();
    expect(parseKey(undefined)).toBeNull();
    expect(parseKey("unknown")).toBeNull();
    expect(parseKey("H major")).toBeNull();
    expect(parseKey("F# dorian")).toBeNull();
    expect(parseKey("174")).toBeNull();
  });
});

describe("toCamelot", () => {
  it("projects minor keys onto the A ring and major onto the B ring", () => {
    expect(toCamelot({ isMinor: true, pitchClass: 9 })).toEqual({ letter: "A", number: 8 });
    expect(toCamelot({ isMinor: false, pitchClass: 0 })).toEqual({ letter: "B", number: 8 });
  });
});

describe("keyToCamelotCode", () => {
  it("round-trips scale text to a wheel code", () => {
    expect(keyToCamelotCode("A minor")).toBe("8A");
    expect(keyToCamelotCode("F major")).toBe("7B");
    expect(keyToCamelotCode("Bb minor")).toBe("3A");
  });

  it("returns null for unparseable input", () => {
    expect(keyToCamelotCode("nonsense")).toBeNull();
    expect(keyToCamelotCode(null)).toBeNull();
  });
});
