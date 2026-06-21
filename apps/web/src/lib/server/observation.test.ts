import { describe, expect, it } from "vitest";

import { gateObservationScript, scanObservationScript } from "./observation";

// The voice gate's automatable half (VOICE.md §3 bans + the Dry Rule + no
// "we"-as-company). The North-Star human sign-off on the rendered audio is a
// separate content control; this only covers the mechanical scan.

const CLEAN =
  "Arrived on the dark side of the sector and this one moved at a hard, even pace. Knees went up before I clocked the coordinate. Logged it as fluncle://004.7.2I. Hope it gets an oof out of you, fam.";

describe("scanObservationScript", () => {
  it("passes a clean recovered-audio observation", () => {
    expect(scanObservationScript(CLEAN)).toEqual([]);
  });

  it("flags the banned identity word 'signal'", () => {
    const violations = scanObservationScript("The signal carried a clean pace, fam.");
    expect(violations.some((v) => v.word === "signal")).toBe(true);
  });

  it("flags 'transmission'", () => {
    const violations = scanObservationScript("Picked up the transmission and the knees went up.");
    expect(violations.some((v) => v.word === "transmission")).toBe(true);
  });

  it("does not false-positive on 'signature' (whole-word match)", () => {
    expect(scanObservationScript("Pure Calibre, the Signature sound, fam.")).toEqual([]);
  });

  it("flags an exclamation mark (the Dry Rule)", () => {
    const violations = scanObservationScript("This one threw me three sectors sideways!");
    expect(violations.some((v) => v.reason.includes("exclamation"))).toBe(true);
  });

  it('flags "we" as a company', () => {
    const violations = scanObservationScript("We logged this one out past the next sector, fam.");
    expect(violations.some((v) => v.reason.includes("we"))).toBe(true);
  });

  it("flags earthly geography (a nationality leaking from the context_note)", () => {
    const violations = scanObservationScript(
      "This one flies the flag for the American side of the map, fam.",
    );
    expect(violations.some((v) => v.word === "american")).toBe(true);
    expect(violations.some((v) => v.reason.includes("geography"))).toBe(true);
  });

  it("flags the dotted abbreviation 'u.k.'", () => {
    const violations = scanObservationScript(
      "Came up out of the u.k. scene and the knees went up, fam.",
    );
    expect(violations.some((v) => v.word === "u.k.")).toBe(true);
  });

  it("passes a clean cosmic observation with no earthly geography", () => {
    expect(
      scanObservationScript(
        "Came in from a far sector and the air went thick. Knees went up before I clocked the coordinate. Hope it does the same to you, fam.",
      ),
    ).toEqual([]);
  });
});

describe("gateObservationScript", () => {
  it("returns the trimmed text for a clean script", () => {
    expect(gateObservationScript(`  ${CLEAN}  `)).toBe(CLEAN);
  });

  it("throws no_script for a non-string or empty script", () => {
    expect(() => gateObservationScript(undefined)).toThrowError(/required/);
    expect(() => gateObservationScript("   ")).toThrowError(/required/);
  });

  it("throws script_too_short below the floor", () => {
    expect(() => gateObservationScript("Oof, banger.")).toThrowError(/too short/);
  });

  it("throws voice_gate on a banned word", () => {
    expect(() =>
      gateObservationScript(
        "The signal carried a clean, even pace and the knees went up before I clocked the coordinate, fam.",
      ),
    ).toThrowError(/voice gate/);
  });

  it("throws voice_gate with a geography reason on earthly geography", () => {
    expect(() =>
      gateObservationScript(
        "This one flies the flag for the American side of the map and the knees went up before I clocked the coordinate, fam.",
      ),
    ).toThrowError(/geography/);
  });
});
