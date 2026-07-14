// Unit tests for the pure helpers in observe-sweep.ts — the authoring PROMPT (where the
// vibe-neighbour layer + the closer-variation rails live) and the echo-move reader that
// drives the re-author pass. The box scripts are self-contained (they cannot import the
// workspace) and live outside any package's test runner, so this file uses `bun:test`:
//
//   bun test docs/agents/hermes/scripts/observe-sweep.test.ts
//
// The layer's RISK is that the neighbours get templated instead of informing, so the
// prompt's anti-sameness instruction is load-bearing product behaviour, not prose — it is
// asserted here, and enforced for real by the Worker's echo gate (its own tests in
// apps/web/src/lib/server/observation-echo.test.ts). The registry-default lockstep is
// pinned separately by prompt-drift.test.ts.

import { describe, expect, test } from "bun:test";
import { buildAuthoringPrompt, type Neighbor, readEchoedMove } from "./observe-sweep";

const FINDING = {
  artists: ["Calibre"],
  galaxy: { name: "The Drift" },
  label: "Signature",
  releaseDate: "2008-03-01",
  title: "Mr Right On",
};

const CONTEXT = "Signature Recordings, 2008.\nTexture: half-step, patient.";

const NEIGHBORS: Neighbor[] = [
  { logId: "012.2.4L", script: "My shoulders went before I'd clocked the coordinate." },
  { logId: "012.1.0A", script: "The pads hang like weather over a patient half-step." },
];

describe("buildAuthoringPrompt", () => {
  test("carries the context note as the primary fuel", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT);

    expect(prompt).toContain("CONTEXT NOTE");
    expect(prompt).toContain("Texture: half-step, patient.");
  });

  test("lays out the sonic neighbourhood with each neighbour's standing script", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS);

    expect(prompt).toContain("THE SONIC NEIGHBOURHOOD");
    expect(prompt).toContain(`012.2.4L: "My shoulders went before I'd clocked the coordinate."`);
    expect(prompt).toContain(`012.1.0A: "The pads hang like weather over a patient half-step."`);
    // The load-bearing half: the neighbourhood is a list of what is TAKEN, not a template.
    expect(prompt).toContain("ALREADY TAKEN");
    expect(prompt).toContain("SPENT");
  });

  test("no neighbourhood block when the region is empty (the pre-layer prompt)", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, []);

    expect(prompt).not.toContain("THE SONIC NEIGHBOURHOOD");
  });

  test("breaks the closer formula: the worn sign-off is named, the kin names rotate", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT);

    // The audit's 32/61 verbatim closer, named as worn through — with variation, not deletion:
    // the crew turn stays required, the kin vocabulary rotates, no-sign-off is allowed.
    expect(prompt).toContain("enjoy, cosmonauts");
    expect(prompt).toContain("worn through");
    expect(prompt).toContain("junglist, raver, fam, cosmonaut");
    expect(prompt).toContain("no sign-off");
    // The "hope" crutch (51/61) and the opener register (34/61 on "I…") are both addressed.
    expect(prompt).toContain('Drop "hope" as a reflex');
    expect(prompt).toContain("VARY THE OPENER");
  });

  test("the re-author pass hands the model its own spent move", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS, "my shoulders went before");

    expect(prompt).toContain("YOUR LAST ATTEMPT WAS REJECTED");
    expect(prompt).toContain('"my shoulders went before"');
  });
});

describe("readEchoedMove", () => {
  test("pulls the lifted phrase out of the Worker's human-readable error", () => {
    expect(
      readEchoedMove(
        'The observation echoes its sonic neighbourhood: it lifts "my shoulders went before" straight from 012.2.4L.',
      ),
    ).toBe("my shoulders went before");
  });

  test("tolerates the JSON-escaped quoting the --json envelope emits", () => {
    expect(
      readEchoedMove(
        '{"message":"it lifts \\"the drop landed sideways\\" straight from 012.1.0A"}',
      ),
    ).toBe("the drop landed sideways");
  });

  test("returns undefined for an overlap-only rejection (no lifted phrase to name)", () => {
    expect(readEchoedMove("it reuses 42% of 012.1.0A's words")).toBeUndefined();
  });
});
