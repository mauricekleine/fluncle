import { describe, expect, it } from "vitest";
import { MAX_SET_LENGTH, mixReasonLabel, parseSetParam, serializeSet } from "./mix-set";

describe("parseSetParam", () => {
  it("splits, trims, and keeps only well-formed finding coordinates in order", () => {
    expect(parseSetParam("004.7.2I, 011.1.6E ,019.8.6S")).toEqual([
      "004.7.2I",
      "011.1.6E",
      "019.8.6S",
    ]);
  });

  it("drops junk and mixtape coordinates without a DB hit", () => {
    expect(parseSetParam("004.7.2I,not-a-coord,019.F.1A,,")).toEqual(["004.7.2I"]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(parseSetParam("004.7.2I,011.1.6E,004.7.2I")).toEqual(["004.7.2I", "011.1.6E"]);
  });

  it("caps at MAX_SET_LENGTH", () => {
    const many = Array.from({ length: MAX_SET_LENGTH + 10 }, (_, i) => {
      const n = String(i).padStart(3, "0");
      return `${n}.1.1A`;
    }).join(",");
    expect(parseSetParam(many)).toHaveLength(MAX_SET_LENGTH);
  });

  it("returns an empty list for empty / nullish input", () => {
    expect(parseSetParam("")).toEqual([]);
    expect(parseSetParam(undefined)).toEqual([]);
    expect(parseSetParam(null)).toEqual([]);
  });
});

describe("serializeSet", () => {
  it("round-trips through parseSetParam", () => {
    const chain = ["004.7.2I", "011.1.6E", "019.8.6S"];
    expect(parseSetParam(serializeSet(chain))).toEqual(chain);
  });
});

describe("mixReasonLabel", () => {
  it("renders a crew-facing string, never a number", () => {
    expect(mixReasonLabel({ kind: "key", relationship: "same_key" })).toBe("Same key");
    expect(mixReasonLabel({ kind: "bpm", relationship: "tempo_match" })).toBe("Tempo locked");
    expect(mixReasonLabel({ kind: "sonic", relationship: "close_in_sound" })).toBe(
      "Close in sound",
    );
    expect(mixReasonLabel({ kind: "key", relationship: "same_key" })).not.toMatch(/\d/);
  });
});
