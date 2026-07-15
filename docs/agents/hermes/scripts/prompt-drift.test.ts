// THE DRIFT GUARD — the registry's baked default must render to EXACTLY the prompt the
// sweep's own inlined builder produces.
//
// WHY THIS TEST EXISTS. The prompt registry (docs/agents/prompt-registry.md) has two
// copies of every on-box prompt, and it has to:
//
//   1. `PROMPT_REGISTRY[slug].defaultBody` in the WORKER — the body served over
//      `get_prompt` when nobody has overridden the prompt. The operator sees this one in
//      /admin, diffs against it, and resets to it.
//   2. `buildAuthoringPrompt` / `buildTriagePrompt` in the SWEEP — the offline FALLBACK,
//      the thing that runs when the registry cannot be reached at all. The box cannot
//      import the workspace at runtime, so it cannot share (1); the duplication is the
//      price of having a fallback at all.
//
// If those two drift, the failure is INVISIBLE until the day the API is unreachable — and
// then the sweep quietly authors against a stale prompt nobody has read in months, with
// `promptVersion: null` as the only clue. That is exactly the class of silent degradation
// this whole feature is supposed to make impossible.
//
// So: pin them. A test is the only thing that can, because the box genuinely cannot import
// the Worker's copy. This test CAN — it runs in the repo, and `*.test.ts` is stripped from
// the box image, so importing across the boundary here costs the box nothing.
//
// If this test fails, you changed one copy and not the other. Change both.

import { describe, expect, test } from "bun:test";

import { PROMPT_REGISTRY, renderPrompt } from "../../../../apps/web/src/lib/server/prompts";
import { buildAuthoringPrompt as buildLogbookPrompt } from "./logbook-sweep";
import { buildAuthoringPrompt as buildNewsletterPrompt } from "./newsletter-sweep";
import { buildAuthoringPrompt as buildNotePrompt } from "./note-sweep";
import { buildAuthoringPrompt as buildObservePrompt } from "./observe-sweep";
import { buildTriagePrompt } from "./triage-sweep";

/** Render the registry's baked default for a slug with the given variables. */
function fromRegistry(slug: keyof typeof PROMPT_REGISTRY, variables: Record<string, string>) {
  return renderPrompt(PROMPT_REGISTRY[slug].defaultBody, variables).trim();
}

describe("the registry default and the sweep's inlined fallback are the same prompt", () => {
  test("note_author", () => {
    const finding = {
      artists: ["Netsky"],
      bpm: 174,
      galaxy: { name: "Deep Field" },
      key: "A minor",
      label: "Hospital",
      releaseDate: "2010-05-01",
      title: "Iron Heart",
    };
    const contextNote = "Released on Hospital Records in 2010.\nTexture: rolling, nocturnal.";
    const neighbors = [
      {
        artists: ["Calibre"],
        logId: "012.1.0A",
        note: "Rolls like weather.",
        title: "Mr Right On",
      },
    ];

    expect(
      fromRegistry("note_author", {
        artists: "Netsky",
        bpm: "174",
        contextNote,
        galaxy: "Deep Field",
        key: "A minor",
        label: "Hospital",
        neighbours: `  - Calibre — Mr Right On: "Rolls like weather."`,
        noContextNote: "",
        title: "Iron Heart",
        year: "2010",
      }),
    ).toBe(buildAuthoringPromptTrimmed(() => buildNotePrompt(finding, contextNote, neighbors)));
  });

  // The no-context arm: the `{{#if noContextNote}}` branch must reproduce the builder's
  // "(No context note on file …)" line, because the two-flag pattern is where a renderer
  // with no `else` is easiest to get subtly wrong.
  test("note_author — the NO-context-note arm", () => {
    const finding = {
      artists: ["Netsky"],
      bpm: 174,
      galaxy: { name: "Deep Field" },
      key: "A minor",
      label: "Hospital",
      releaseDate: "2010-05-01",
      title: "Iron Heart",
    };

    expect(
      fromRegistry("note_author", {
        artists: "Netsky",
        bpm: "174",
        contextNote: "",
        galaxy: "Deep Field",
        key: "A minor",
        label: "Hospital",
        neighbours: "",
        noContextNote: "yes",
        title: "Iron Heart",
        year: "2010",
      }),
    ).toBe(buildAuthoringPromptTrimmed(() => buildNotePrompt(finding, "", [])));
  });

  test("observation_script", () => {
    const finding = {
      artists: ["Calibre"],
      galaxy: { name: "The Drift" },
      label: "Signature",
      releaseDate: "2008-03-01",
      title: "Mr Right On",
    };
    const contextNote = "Signature Recordings, 2008.\nTexture: half-step, patient.";

    expect(
      fromRegistry("observation_script", {
        artists: "Calibre",
        contextNote,
        galaxy: "The Drift",
        label: "Signature",
        noContextNote: "",
        title: "Mr Right On",
        year: "2008",
      }),
    ).toBe(buildAuthoringPromptTrimmed(() => buildObservePrompt(finding, contextNote)));
  });

  // The vibe-neighbour + echo arms: the neighbourhood block and the re-author block are the
  // anti-sameness rails, and a renderer with no `else` is easiest to get subtly wrong there.
  test("observation_script — with the neighbourhood + a spent move", () => {
    const finding = {
      artists: ["Calibre"],
      galaxy: { name: "The Drift" },
      label: "Signature",
      releaseDate: "2008-03-01",
      title: "Mr Right On",
    };
    const contextNote = "Signature Recordings, 2008.\nTexture: half-step, patient.";
    const neighbors = [{ logId: "012.1.0A", script: "The bass walked in on its own two feet." }];

    expect(
      fromRegistry("observation_script", {
        artists: "Calibre",
        contextNote,
        echoedMove: "my shoulders went before",
        galaxy: "The Drift",
        label: "Signature",
        neighbours: `  - 012.1.0A: "The bass walked in on its own two feet."`,
        noContextNote: "",
        title: "Mr Right On",
        year: "2008",
      }),
    ).toBe(
      buildAuthoringPromptTrimmed(() =>
        buildObservePrompt(finding, contextNote, neighbors, "my shoulders went before"),
      ),
    );
  });

  // NOTE: the entity-bio prompts (`describe_artist` / `describe_label`) are NO LONGER pinned
  // here. The box no longer carries a baked bio prompt: the bio crons are Worker-paced — the
  // Worker assembles the registered `describe_*` prompt (Firecrawl facts + finding titles) in
  // `draft_artist_bio` / `draft_label_bio` and hands the box the finished text, so there is no
  // on-box copy that could drift from the registry. See docs/agents/bio-agent.md.

  test("triage_verdict", () => {
    const submission = { album: "Colours", artists: ["Netsky"], title: "Iron Heart" };
    const assessment = {
      archived: false,
      plausibility: "likely" as const,
      signals: ["label is a known DnB imprint"],
    };
    const built = buildTriagePrompt(submission, assessment);

    // The `lean` line is derived inside the sweep, so read it back off the built prompt
    // rather than restating it here (restating it is exactly how a drift guard drifts).
    const lean = built.split("\n").find((line) => line.trim().startsWith("lean:"));

    expect(lean).toBeDefined();

    expect(
      fromRegistry("triage_verdict", {
        album: "Colours",
        artists: "Netsky",
        lean: (lean ?? "").replace(/^\s*lean:\s*/, ""),
        signals: "label is a known DnB imprint",
        title: "Iron Heart",
      }),
    ).toBe(built.trim());
  });
});

/** Run a builder and trim it the same way `renderPrompt` trims. */
function buildAuthoringPromptTrimmed(build: () => string): string {
  return build().trim();
}

// The logbook + newsletter builders take richer inputs (a day's findings, a week's
// findings + mixtapes), and their sweeps pre-join those into ONE string variable each. So
// the drift that matters for them is the SURROUNDING prose, which is what these assert:
// render the registry default with the builder's own pre-joined block and require the two
// to match exactly.
describe("the registry default and the fallback agree on the surrounding prose", () => {
  test("logbook_entry", () => {
    const gap = {
      date: "2026-07-04",
      findings: [
        {
          artists: ["Calibre"],
          logId: "036.7.2I",
          note: "Rolls like weather.",
          posterUrl: "https://example.invalid/p.jpg",
          title: "Mr Right On",
        },
      ],
      sector: 36,
    };
    const built = buildLogbookPrompt(gap).trim();

    // The findings block is everything between the figure-token contract and OUTPUT FORMAT.
    const start = built.indexOf("FINDING 1:");
    const end = built.indexOf("OUTPUT FORMAT (exactly):");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // The sweep passes `buildFindingBlocks(...).join("\n")`, whose last element is an empty
    // string — so the real variable ends with exactly ONE newline. Reproduce that, or the
    // guard measures its own slicing rather than the two prompts.
    const findings = built.slice(start, end).replace(/\n+$/, "\n");

    expect(fromRegistry("logbook_entry", { date: "2026-07-04", findings, sector: "36" })).toBe(
      built,
    );
  });

  test("newsletter_edition", () => {
    const findings = [{ logId: "021.7.1A", note: "Rolls like weather." }];
    const mixtapes: { logId?: string; note?: string }[] = [];
    const built = buildNewsletterPrompt(findings, mixtapes).trim();

    expect(
      fromRegistry("newsletter_edition", {
        findingCount: "1",
        findings: "- logId=021.7.1A | note: Rolls like weather.",
        mixtapeCount: "0",
        mixtapes: "(none)",
      }),
    ).toBe(built);
  });
});
