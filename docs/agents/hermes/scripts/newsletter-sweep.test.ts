// Unit tests for the pure helpers in newsletter-sweep.ts — the anti-sameness rail's two
// light pieces (the ledger holds the heavy rail until ≥4 editions):
//   1. `collectPriorWhys` — the already-sent why-lines mined from the sent editions
//      `listEditions` already reads, handed to the author as SPENT moves. Its whole job is
//      to be best-effort: an edition with no/malformed content contributes nothing, never
//      throws, and a fresh list yields none.
//   2. the `promptVariables` / `buildAuthoringPrompt` threading — the intra-edition
//      diversity rule (always on) plus the spent-whys block (present only with history).
//
// The box scripts are self-contained (they cannot import the workspace) and live outside any
// package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/newsletter-sweep.test.ts
//
// The byte-equality between the fallback here and the registry default is pinned separately
// by prompt-drift.test.ts; this file is about the sweep's own logic.

import { describe, expect, test } from "bun:test";
import { buildAuthoringPrompt, collectPriorWhys, promptVariables } from "./newsletter-sweep";

// A minimal Edition-shaped row as `admin newsletter list --json` returns it (parsed content).
type EditionRow = {
  content?: { galaxies?: Array<{ findings?: Array<{ why?: unknown }> }>; mixtapeRef?: unknown };
  number?: number | null;
  status?: string;
};

const sentEdition = (number: number, whys: string[]): EditionRow => ({
  content: { galaxies: [{ findings: whys.map((why) => ({ logId: "x", why })) }] },
  number,
  status: "sent",
});

describe("collectPriorWhys", () => {
  test("pulls every why-line out of the sent editions' content", () => {
    const editions = [
      sentEdition(2, ["knees went up before I'd clocked the drop", "the pad kept climbing"]),
      sentEdition(1, ["shoulders dropped and stayed down"]),
    ];

    expect(collectPriorWhys(editions)).toEqual([
      "knees went up before I'd clocked the drop",
      "the pad kept climbing",
      "shoulders dropped and stayed down",
    ]);
  });

  test("reads the newest sent editions first", () => {
    const editions = [
      sentEdition(1, ["older why"]),
      sentEdition(3, ["newest why"]),
      sentEdition(2, ["middle why"]),
    ];

    expect(collectPriorWhys(editions)).toEqual(["newest why", "middle why", "older why"]);
  });

  test("ignores DRAFT editions — only sent whys are spent", () => {
    const draft: EditionRow = {
      content: { galaxies: [{ findings: [{ why: "not sent yet" }] }] },
      number: null,
      status: "draft",
    };

    expect(collectPriorWhys([draft, sentEdition(1, ["sent why"])])).toEqual(["sent why"]);
  });

  test("returns an empty list when nothing has been sent (n=0)", () => {
    expect(collectPriorWhys([])).toEqual([]);
    expect(
      collectPriorWhys([{ content: { galaxies: [] }, number: null, status: "draft" }]),
    ).toEqual([]);
  });

  test("skips malformed content without throwing", () => {
    const malformed: EditionRow[] = [
      // The good line lives in the NEWEST edition so it survives the recent-editions cap; a
      // non-string why and a blank why beside it must both be dropped.
      {
        content: { galaxies: [{ findings: [{ why: 42 }, { why: "  " }, { why: "good one" }] }] },
        number: 5,
        status: "sent",
      },
      { content: undefined, number: 4, status: "sent" },
      { content: { galaxies: undefined }, number: 3, status: "sent" },
      // galaxies not an array, then findings not an array.
      { content: { galaxies: "nope" as unknown as [] }, number: 2, status: "sent" },
      { content: { galaxies: [{ findings: "nope" as unknown as [] }] }, number: 1, status: "sent" },
    ];

    expect(() => collectPriorWhys(malformed)).not.toThrow();
    expect(collectPriorWhys(malformed)).toEqual(["good one"]);
  });

  test("caps the harvested lines (does not hand the author an unbounded backlog)", () => {
    const many = Array.from({ length: 30 }, (_, i) => `why ${i}`);
    const result = collectPriorWhys([sentEdition(1, many)]);

    expect(result.length).toBeLessThanOrEqual(12);
    expect(result[0]).toBe("why 0");
  });
});

describe("promptVariables threading", () => {
  test("carries the spent whys as one pre-joined bullet list", () => {
    const vars = promptVariables(
      [{ logId: "021.7.1A", note: "n" }],
      [],
      ["knees went up", "shoulders dropped"],
    );

    expect(vars.priorWhys).toBe("- knees went up\n- shoulders dropped");
  });

  test("renders priorWhys empty when there is no history (the template drops the block)", () => {
    const vars = promptVariables([{ logId: "021.7.1A", note: "n" }], []);

    expect(vars.priorWhys).toBe("");
  });
});

describe("buildAuthoringPrompt anti-sameness rails", () => {
  const findings = [{ logId: "021.7.1A", note: "Rolls like weather." }];

  test("always names the intra-edition diversity rule (the light piece with n=1)", () => {
    const prompt = buildAuthoringPrompt(findings, []);

    expect(prompt).toContain("Within one edition");
    expect(prompt).toContain("so no two whys rhyme");
    expect(prompt).toContain("body-clock formula");
  });

  test("carries the already-sent whys as SPENT moves when there is history", () => {
    const prompt = buildAuthoringPrompt(findings, [], ["shoulders dropped and stayed down"]);

    expect(prompt).toContain("ALREADY SENT");
    expect(prompt).toContain("- shoulders dropped and stayed down");
    expect(prompt).toContain("write past them, never echo a move");
  });

  test("omits the spent-whys block entirely on the first edition (no history)", () => {
    const prompt = buildAuthoringPrompt(findings, []);

    expect(prompt).not.toContain("ALREADY SENT");
    // …and it is still a complete, authorable prompt.
    expect(prompt).toContain("Output ONLY the JSON object.");
  });
});
