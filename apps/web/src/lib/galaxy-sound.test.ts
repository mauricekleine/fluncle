import { describe, expect, it } from "vitest";
import { GALAXY_SOUND_LINES, galaxySoundLine } from "./galaxy-sound";

const LINES = Object.entries(GALAXY_SOUND_LINES);

const BANNED_WORDS = [
  /\btransmissions?\b/i,
  /\bsignals?\b/i,
  /\banomal(y|ies)\b/i,
  /\bcurat(ed|ion|e|es|ing)\b/i,
  /\bcontent\b/i,
  /\bstream(s|ing)?\b/i,
  /\bmint(s|ed|ing)?\b/i,
];

const ALWAYS_CAPITALISED = /^(I|I'm|I've|I'd|I'll|Fluncle('s)?)\W*$/;

describe("galaxySoundLine", () => {
  it("returns the line for every named galaxy", () => {
    expect(Object.keys(GALAXY_SOUND_LINES).sort()).toEqual(["lunar", "nebular", "pulsar", "solar"]);

    for (const [slug, line] of LINES) {
      expect(galaxySoundLine(slug)).toBe(line);
    }
  });

  it("returns nothing for a galaxy without a line, including prototype keys", () => {
    expect(galaxySoundLine("kalyx")).toBeUndefined();
    expect(galaxySoundLine("")).toBeUndefined();
    expect(galaxySoundLine("constructor")).toBeUndefined();
    expect(galaxySoundLine("toString")).toBeUndefined();
  });

  it("keeps every line distinct, so the lines help a reader choose", () => {
    expect(new Set(LINES.map(([, line]) => line)).size).toBe(LINES.length);
  });
});

describe.each(LINES)("the %s sound line", (_slug, line) => {
  it("is one sentence in sentence case ending in a full stop", () => {
    expect(line).toMatch(/^[A-Z]/);
    expect(line.endsWith(".")).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[.?!]/);
    const laterWords = line
      .split(" ")
      .slice(1)
      .filter((word) => !ALWAYS_CAPITALISED.test(word));
    expect(laterWords).not.toContainEqual(expect.stringMatching(/^[A-Z]/));
  });

  it("carries no em dash and no exclamation mark", () => {
    expect(line).not.toContain("—");
    expect(line).not.toContain("!");
  });

  it("uses none of the voice canon's banned identity words", () => {
    for (const banned of BANNED_WORDS) {
      expect(line).not.toMatch(banned);
    }
  });

  it("stays one short line", () => {
    expect(line.split(" ").length).toBeLessThanOrEqual(22);
  });
});
