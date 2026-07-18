// Unit tests for the pure helpers in logbook-sweep.ts — the authoring PROMPT (where the
// anti-sameness SPENT block lives) and the `readEchoedMove` parser that drives the one
// re-author pass. The box scripts are self-contained (they cannot import the workspace) and
// live outside any package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/logbook-sweep.test.ts
//
// The rail's RISK is the spent moves getting templated instead of informing, so the prompt's
// anti-sameness instruction is load-bearing product behaviour — asserted here, and enforced
// for real by the Worker's title/body gates (logbook.ts + logbook-echo.ts, their own tests
// in apps/web/src/lib/server/logbook.server.test.ts).

import { describe, expect, test } from "bun:test";
import { buildAuthoringPrompt, readEchoedMove, type Spent } from "./logbook-sweep";

const GAP = {
  date: "2026-07-05",
  findings: [{ artists: ["Fizzy"], logId: "036.7.2I", posterUrl: "x", title: "A Cut" }],
  sector: 36,
};

const SPENT: Spent[] = [
  {
    closer: "Enjoy, cosmonauts.",
    opener: "The sector was quiet when I dropped in.",
    sector: 18,
    title: "Shoulders Down",
  },
  {
    closer: "I played it twice.",
    opener: "One long roller, start to finish.",
    sector: 17,
    title: "One roller",
  },
];

describe("buildAuthoringPrompt", () => {
  test("lays the day's findings out with their figure tokens", () => {
    const prompt = buildAuthoringPrompt(GAP);

    expect(prompt).toContain("[[036.7.2I]]");
    expect(prompt).toContain("A Cut");
    expect(prompt).toContain("Fizzy");
  });

  test("carries the SPENT log — the taken titles and the used opener/closer moves", () => {
    const prompt = buildAuthoringPrompt(GAP, SPENT);

    expect(prompt).toContain("THE SPENT LOG");
    expect(prompt).toContain('"Shoulders Down"');
    expect(prompt).toContain("One long roller, start to finish.");
    expect(prompt).toContain("Enjoy, cosmonauts.");
  });

  // THE GUARDRAIL. The spent moves are shown as a list of what is TAKEN, never a template,
  // and the worn moves are named explicitly. If this softens, the rail stops working.
  test("names the worn moves and frames the log as SPENT, not a template", () => {
    const prompt = buildAuthoringPrompt(GAP, SPENT);

    expect(prompt).toContain("TAKEN");
    expect(prompt).toContain("WORN");
    expect(prompt).toContain("Shoulders");
    expect(prompt).toContain("quiet-sector opener");
    expect(prompt).toContain("body-clock");
    expect(prompt).toContain("Enjoy, cosmonauts.");
    // It tells the model the rejection is real, so the constraint has teeth.
    expect(prompt).toContain("REJECTS a title that matches a past one");
  });

  test("omits the spent block entirely when there is no history (the first entries)", () => {
    const prompt = buildAuthoringPrompt(GAP, []);

    expect(prompt).not.toContain("THE SPENT LOG");
    // …and it is still a complete, authorable prompt.
    expect(prompt).toContain("[[036.7.2I]]");
    expect(prompt).toContain("OUTPUT FORMAT (exactly):");
  });

  test("hands the model its own echoed move back on the re-author pass", () => {
    const prompt = buildAuthoringPrompt(GAP, SPENT, "the low end rolled in slow and patient");

    expect(prompt).toContain("YOUR LAST ATTEMPT WAS REJECTED");
    expect(prompt).toContain("the low end rolled in slow and patient");
  });
});

describe("readEchoedMove", () => {
  test("pulls the lifted phrase out of a body-echo rejection (JSON-escaped quotes)", () => {
    const message =
      '{"code":"body_echoes_logbook","message":"The entry echoes the recent logbook: it lifts \\"low end rolled in slow\\" straight from sector 12."}';

    expect(readEchoedMove(message)).toBe("low end rolled in slow");
  });

  test("pulls the colliding title out of a title-collision rejection", () => {
    const message =
      'title_echoes_logbook: The title "Shoulders Down" repeats sector 18\'s "Shoulders Down".';

    expect(readEchoedMove(message)).toBe("Shoulders Down");
  });

  test("returns undefined for an overlap-only rejection (no phrase was lifted)", () => {
    const message = "body_echoes_logbook: it reuses 42% of sector 12's words";

    expect(readEchoedMove(message)).toBeUndefined();
  });
});
