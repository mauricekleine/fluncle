import { describe, expect, it } from "vitest";
import { formatKey } from "./key-notation";

describe("formatKey", () => {
  it("returns the key verbatim in scales notation", () => {
    expect(formatKey("F major", "scales")).toBe("F major");
    expect(formatKey("D minor", "scales")).toBe("D minor");
    expect(formatKey("C# major", "scales")).toBe("C# major");
  });

  // The full 24-key Camelot wheel: 12 major (B ring) + 12 minor (A ring). Sharps are
  // what enrichment writes; the flat equivalents share a pitch class and code.
  const wheel: [string, string][] = [
    // Majors (outer ring, B)
    ["C major", "8B"],
    ["G major", "9B"],
    ["D major", "10B"],
    ["A major", "11B"],
    ["E major", "12B"],
    ["B major", "1B"],
    ["F# major", "2B"],
    ["C# major", "3B"],
    ["G# major", "4B"],
    ["D# major", "5B"],
    ["A# major", "6B"],
    ["F major", "7B"],
    // Minors (inner ring, A)
    ["A minor", "8A"],
    ["E minor", "9A"],
    ["B minor", "10A"],
    ["F# minor", "11A"],
    ["C# minor", "12A"],
    ["G# minor", "1A"],
    ["D# minor", "2A"],
    ["A# minor", "3A"],
    ["F minor", "4A"],
    ["C minor", "5A"],
    ["G minor", "6A"],
    ["D minor", "7A"],
  ];

  it.each(wheel)("maps %s to %s in camelot notation", (scale, camelot) => {
    expect(formatKey(scale, "camelot")).toBe(camelot);
  });

  it("resolves flat spellings to the same code as their sharp enharmonic", () => {
    expect(formatKey("Db major", "camelot")).toBe(formatKey("C# major", "camelot"));
    expect(formatKey("Bb minor", "camelot")).toBe(formatKey("A# minor", "camelot"));
    expect(formatKey("Eb major", "camelot")).toBe("5B");
  });

  it("accepts maj/min shorthand and stray whitespace", () => {
    expect(formatKey("C maj", "camelot")).toBe("8B");
    expect(formatKey("a min", "camelot")).toBe("8A");
    expect(formatKey("  F major  ", "camelot")).toBe("7B");
  });

  it("renders unparseable, empty, or nullish input without throwing", () => {
    expect(formatKey("", "camelot")).toBe("");
    expect(formatKey(undefined, "camelot")).toBe("");
    expect(formatKey(null, "camelot")).toBe("");
    expect(formatKey("unknown", "camelot")).toBe("unknown");
    expect(formatKey("H major", "camelot")).toBe("H major");
    expect(formatKey("F# dorian", "camelot")).toBe("F# dorian");
  });
});
