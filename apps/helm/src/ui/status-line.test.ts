import { describe, expect, test } from "bun:test";

import { parseStatusLine } from "./status-line";

// The pre-flight vocabulary is canon (packages/live/src/show.ts): lines frame as
// `  [token] label.padEnd(22) note` — and sometimes a token with a plain sentence.
describe("parseStatusLine", () => {
  test("a padded show.ts row splits into token, label, note", () => {
    const row = parseStatusLine("  [clear] audio meter            48 kHz, level -18 dB");

    expect(row).toEqual({ label: "audio meter", note: "48 kHz, level -18 dB", token: "clear" });
  });

  test("hold and dark parse too", () => {
    expect(parseStatusLine("  [hold]  disk                   9 GB free, floor is 40")?.token).toBe(
      "hold",
    );
    expect(parseStatusLine("  [dark]  ffmpeg                 no ffmpeg aboard")?.token).toBe(
      "dark",
    );
  });

  test("a token with a plain sentence keeps the sentence as the label", () => {
    const row = parseStatusLine("  [clear] glass placed on display 2 and fullscreened");

    expect(row).toEqual({
      label: "glass placed on display 2 and fullscreened",
      note: "",
      token: "clear",
    });
  });

  test("plain log lines are not rows", () => {
    expect(parseStatusLine("building the plan…")).toBeUndefined();
    expect(parseStatusLine("")).toBeUndefined();
    expect(parseStatusLine("[warn] not a canon token")).toBeUndefined();
  });
});
