import { describe, expect, it } from "vitest";
import { stripSsml } from "./observation-text";

// The observation script embeds SSML tags (`<break time="1.0s" />`, `<emphasis>…`)
// for ElevenLabs; stripSsml drops those spans so the admin transcript reads as clean
// prose. The cases that matter: a tag mid-sentence (the gap collapses to one space),
// a tag at the start (no leading space), several tags in a row, and the no-tag
// passthrough (unchanged besides trim).

describe("stripSsml", () => {
  it("strips a break tag mid-sentence and collapses to a single space", () => {
    expect(stripSsml('It hangs there. <break time="1.0s" /> Then it drops.')).toBe(
      "It hangs there. Then it drops.",
    );
  });

  it("strips a tag at the start with no leading space left behind", () => {
    expect(stripSsml('<break time="0.8s" /> The bass arrives.')).toBe("The bass arrives.");
  });

  it("strips multiple tags, including a paired emphasis span", () => {
    expect(
      stripSsml('A <emphasis>huge</emphasis> drop. <break time="1.5s" /> Silence after.'),
    ).toBe("A huge drop. Silence after.");
  });

  it("leaves prose with no tags unchanged", () => {
    expect(stripSsml("Just a quiet field note, nothing to strip.")).toBe(
      "Just a quiet field note, nothing to strip.",
    );
  });

  it("returns an empty string for whitespace-only or empty input", () => {
    expect(stripSsml("")).toBe("");
    expect(stripSsml('   <break time="1.0s" />   ')).toBe("");
  });
});
