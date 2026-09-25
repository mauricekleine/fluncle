import { describe, expect, test } from "bun:test";

import { PROMPT_REGISTRY, renderPrompt } from "../../../../apps/web/src/lib/server/prompts";
import { buildAuthoringPrompt as buildLogbookPrompt } from "./logbook-sweep";
import { buildAuthoringPrompt as buildNewsletterPrompt } from "./newsletter-sweep";
import { buildAuthoringPrompt as buildNotePrompt } from "./note-sweep";
import { buildAuthoringPrompt as buildObservePrompt } from "./observe-sweep";
import { buildTriagePrompt } from "./triage-sweep";

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

  test("triage_verdict", () => {
    const submission = { album: "Colours", artists: ["Netsky"], title: "Iron Heart" };
    const assessment = {
      archived: false,
      plausibility: "likely" as const,
      signals: ["label is a known DnB imprint"],
    };
    const built = buildTriagePrompt(submission, assessment);

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

function buildAuthoringPromptTrimmed(build: () => string): string {
  return build().trim();
}

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

    const start = built.indexOf("FINDING 1:");
    const end = built.indexOf("OUTPUT FORMAT (exactly):");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

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

  test("newsletter_edition — with the already-sent whys", () => {
    const findings = [{ logId: "021.7.1A", note: "Rolls like weather." }];
    const mixtapes: { logId?: string; note?: string }[] = [];
    const priorWhys = ["knees went up before I'd clocked the drop", "shoulders dropped and stayed"];
    const built = buildNewsletterPrompt(findings, mixtapes, priorWhys).trim();

    expect(
      fromRegistry("newsletter_edition", {
        findingCount: "1",
        findings: "- logId=021.7.1A | note: Rolls like weather.",
        mixtapeCount: "0",
        mixtapes: "(none)",
        priorWhys: "- knees went up before I'd clocked the drop\n- shoulders dropped and stayed",
      }),
    ).toBe(built);
  });
});
