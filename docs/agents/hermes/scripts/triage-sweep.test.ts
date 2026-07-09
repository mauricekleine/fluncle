// Unit tests for the pure helpers in triage-sweep.ts — the box-script sweep is
// self-contained (it can't import the workspace) and lives outside any package's test
// runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/triage-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no fluncle spawn, no claude, no network). Keep this green when
// touching the dedupe/plausibility heuristic or the verdict prompt.
import { describe, expect, test } from "bun:test";

import { assessSubmission, buildTriagePrompt } from "./triage-sweep";

describe("assessSubmission", () => {
  test("archived (spotify id already in the archive) dominates: archived + a lead signal", () => {
    const result = assessSubmission({
      archived: true,
      artists: ["Calibre"],
      title: "Mr Right On",
    });

    expect(result.archived).toBe(true);
    expect(result.signals[0]).toContain("already maps to a finding");
  });

  test("a DnB-positive keyword in the title reads 'likely'", () => {
    const result = assessSubmission({
      archived: false,
      artists: ["Unknown"],
      title: "Some Tune (Neurofunk VIP)",
    });

    expect(result.plausibility).toBe("likely");
    expect(result.signals.some((s) => s.includes("neurofunk"))).toBe(true);
  });

  test("a known archive artist is a strong same-lane prior → 'likely'", () => {
    const result = assessSubmission({
      archived: false,
      artists: ["Nu:Tone"],
      knownArtists: ["nu:tone", "logistics"],
      title: "Falling",
    });

    expect(result.plausibility).toBe("likely");
    expect(result.signals.some((s) => s.includes("already in the archive"))).toBe(true);
  });

  test("an off-lane keyword with nothing positive reads 'unlikely'", () => {
    const result = assessSubmission({
      album: "Piano Version",
      archived: false,
      artists: ["Somebody"],
      title: "Ballad (Acoustic)",
    });

    expect(result.plausibility).toBe("unlikely");
  });

  test("no genre tell at all is the honest default 'unclear' (most DnB carries no tag)", () => {
    const result = assessSubmission({
      archived: false,
      artists: ["Whoever"],
      title: "Untitled",
    });

    expect(result.plausibility).toBe("unclear");
    expect(result.signals).toEqual([]);
  });

  test("matching is case-insensitive and substring (so 'DnB' in a version tag hits)", () => {
    const result = assessSubmission({
      archived: false,
      artists: ["X"],
      title: "Track — DNB Mix",
    });

    expect(result.plausibility).toBe("likely");
  });
});

describe("buildTriagePrompt", () => {
  test("interpolates the metadata and the deterministic lean, and forbids em dashes/quotes", () => {
    const prompt = buildTriagePrompt(
      { album: "Album", artists: ["Calibre"], title: "Mr Right On" },
      { archived: true, plausibility: "unclear", signals: ["spotify id already maps"] },
    );

    expect(prompt).toContain("Calibre");
    expect(prompt).toContain("Mr Right On");
    expect(prompt).toContain("ALREADY LOGGED");
    expect(prompt).toContain("copywriting-fluncle");
    // The three-verdict register is named for the model.
    expect(prompt).toContain("already logged");
    expect(prompt).toContain("not our lane");
  });

  test("a likely, un-archived submission leans 'looks like a find'", () => {
    const prompt = buildTriagePrompt(
      { artists: ["Unknown"], title: "Neurofunk Roller" },
      { archived: false, plausibility: "likely", signals: ['title/album names "neurofunk"'] },
    );

    expect(prompt).toContain("LOOKS LIKE A FIND");
  });
});
