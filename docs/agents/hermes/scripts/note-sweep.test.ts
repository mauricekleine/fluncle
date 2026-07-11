// Unit tests for the pure helpers in note-sweep.ts — the authoring PROMPT (where the
// vibe-neighbour layer actually lives) and the echo-phrase reader that drives the
// re-author pass. The box scripts are self-contained (they cannot import the workspace)
// and live outside any package's test runner, so this file uses `bun:test` and is run
// directly:
//
//   bun test docs/agents/hermes/scripts/note-sweep.test.ts
//
// The layer's RISK is that the neighbours get templated instead of informing, so the
// prompt's anti-sameness instruction is load-bearing product behaviour, not prose — it
// is asserted here, and enforced for real by the Worker's echo gate (which has its own
// tests in apps/web/src/lib/server/note.test.ts).

import { describe, expect, test } from "bun:test";
import { buildAuthoringPrompt, type Neighbor, readEchoedPhrase } from "./note-sweep";

const FINDING = {
  artists: ["Whiney"],
  bpm: 174.02,
  key: "F minor",
  label: "Med School",
  logId: "011.5.9D",
  releaseDate: "2016-03-11",
  title: "Nightfall",
};

const CONTEXT = "Whiney's Nightfall is a 2016 single on Med School.\n\nTexture: deep, nocturnal.";

const NEIGHBORS: Neighbor[] = [
  {
    artists: ["Krakota"],
    logId: "012.2.4L",
    note: "Liquid roller with nocturnal depth; I've been rewinding this Krakota banger since 2018.",
    title: "See For Miles",
  },
  {
    artists: ["GLXY"],
    logId: "012.1.0A",
    note: "Liquid and introspective; GLXY dropped this in 2015 and my shoulders still follow.",
    title: "It's Whatever",
  },
];

describe("buildAuthoringPrompt", () => {
  test("carries the context note as the primary fuel", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT);

    expect(prompt).toContain("CONTEXT NOTE");
    expect(prompt).toContain("Texture: deep, nocturnal.");
  });

  test("grounds the note in the AUDIO too (bpm + key, alongside the galaxy)", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT);

    expect(prompt).toContain("bpm: 174");
    expect(prompt).toContain("key: F minor");
  });

  test("lays out the sonic neighbourhood with each neighbour's standing note", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS);

    expect(prompt).toContain("THE SONIC NEIGHBOURHOOD");
    expect(prompt).toContain("Krakota — See For Miles");
    expect(prompt).toContain("my shoulders still follow");
  });

  // THE GUARDRAIL. The neighbours are shown as a list of what is TAKEN, never as a
  // template to match. If this instruction ever softens, the layer starts homogenising
  // the voice — which is the one outcome that makes it a net negative.
  test("frames the neighbourhood as SPENT moves, not as a template", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS);

    expect(prompt).toContain("WHAT IS ALREADY TAKEN");
    expect(prompt).toContain("SPENT");
    expect(prompt).toContain("Do not reuse one");
    // It tells the model the rejection is real, so the constraint has teeth.
    expect(prompt).toContain("REJECTS a note that lifts a run of words");
  });

  test("omits the neighbourhood block entirely when there is none (the control arm)", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, []);

    expect(prompt).not.toContain("THE SONIC NEIGHBOURHOOD");
    // …and it is still a complete, authorable prompt.
    expect(prompt).toContain("CONTEXT NOTE");
    expect(prompt).toContain("Output ONLY the note text.");
  });

  test("hands the model its own echo back on the re-author pass", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS, "my shoulders dropped before");

    expect(prompt).toContain("YOUR LAST ATTEMPT WAS REJECTED");
    expect(prompt).toContain("my shoulders dropped before");
  });
});

describe("readEchoedPhrase", () => {
  test("pulls the lifted phrase out of the Worker's rejection", () => {
    const message =
      '{"code":"note_echoes_neighbours","message":"The note echoes its sonic neighbourhood: it lifts \\"my shoulders dropped before\\" straight from 027.2.8R."}';

    expect(readEchoedPhrase(message)).toBe("my shoulders dropped before");
  });

  test("returns undefined for an overlap rejection (no phrase was lifted)", () => {
    const message = "note_echoes_neighbours: it reuses 34% of 012.1.0A's words";

    expect(readEchoedPhrase(message)).toBeUndefined();
  });
});
