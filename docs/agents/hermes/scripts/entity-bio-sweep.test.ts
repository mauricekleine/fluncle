// Unit tests for entity-bio-sweep.ts — the two load-bearing seams the box scripts being
// self-contained (they cannot import the workspace) let us pin without a live CLI/DB:
//
//   1. `isAuthorableDraft` — the Worker-draft GATE. The box triggers `draft-bio` (the
//      Worker-paced grounding read) per queued entity; the sweep only authors when the
//      Worker RESOLVED the entity and returned a non-empty prompt. A null draft (a failed
//      call / gather) or a `found:false` (unresolved slug) is a clean skip — never an
//      author. This is the Worker-paced parity with the context-note sweep.
//   2. `bioCostEvent` — the COST-01 metering seam. The ledger tracks DELIVERED work: a `bio`
//      authoring-spend row is recorded ONLY when a bio was actually authored AND stored this
//      tick, NEVER on a dry-run, an operator-bio no-op, a gate rejection, or a failure. Its
//      shape mirrors note-sweep's `note` row (subsidized/anthropic/tokens/measured), just
//      with `step: "bio"` and the entity slug as the id scope.
//
// This file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/entity-bio-sweep.test.ts

import { describe, expect, test } from "bun:test";
import { costEventId } from "./cost-emit";
import { bioCostEvent, isAuthorableDraft } from "./entity-bio-sweep";

const DRAFT = {
  findingCount: 3,
  found: true,
  hasFacts: true,
  name: "Calibre",
  prompt: "You are Fluncle, writing the bio for Calibre…",
  promptVersion: 0,
};

describe("isAuthorableDraft (the Worker-draft gate)", () => {
  test("authors on a resolved draft with a non-empty prompt", () => {
    expect(isAuthorableDraft(DRAFT)).toBe(true);
  });

  test("SKIPS on a null draft (the draft-bio call / gather failed)", () => {
    expect(isAuthorableDraft(null)).toBe(false);
  });

  test("SKIPS on found:false (the Worker did not resolve the slug)", () => {
    expect(isAuthorableDraft({ ...DRAFT, found: false })).toBe(false);
  });

  test("SKIPS on an empty prompt (nothing to author)", () => {
    expect(isAuthorableDraft({ ...DRAFT, prompt: "   " })).toBe(false);
    expect(isAuthorableDraft({ ...DRAFT, prompt: undefined })).toBe(false);
  });
});

const AUTHORED = {
  bio: "Calibre is a drum and bass producer.",
  model: "claude-sonnet-4-6",
  promptVersion: 0,
  tokens: 1500,
  usd: 0.042,
};

describe("bioCostEvent (the COST-01 §5 `bio` row)", () => {
  test("records a subsidized/anthropic/tokens row ONLY on a real authored+stored bio", () => {
    const row = bioCostEvent({
      authored: AUTHORED,
      dryRun: false,
      outcome: "authored",
      slug: "calibre",
    });

    expect(row).toEqual({
      costBasis: "subsidized",
      logId: "calibre",
      model: "claude-sonnet-4-6",
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown as string,
      quantity: 1500,
      source: "measured",
      step: "bio",
      trackId: null,
      unitType: "tokens",
      usd: 0.042,
      vendor: "anthropic",
    });
  });

  test("scopes the idempotency id by the entity SLUG (a bio has no finding coordinate)", () => {
    const row = bioCostEvent({
      authored: AUTHORED,
      dryRun: false,
      outcome: "authored",
      slug: "shogun-audio",
    });

    if (!row) {
      throw new Error("expected an authored bio to record a cost row");
    }

    expect(costEventId(row)).toBe(`bio:shogun-audio:anthropic:tokens:${row.occurredAt}`);
  });

  test("carries a null usd through unpriced (never laundered to $0)", () => {
    const row = bioCostEvent({
      authored: { ...AUTHORED, usd: null },
      dryRun: false,
      outcome: "authored",
      slug: "calibre",
    });

    expect(row?.usd).toBeNull();
  });

  test("records NOTHING on a dry run (nothing was stored)", () => {
    expect(
      bioCostEvent({ authored: AUTHORED, dryRun: true, outcome: "authored", slug: "calibre" }),
    ).toBeNull();
  });

  test("records NOTHING on an operator-bio no-op, a gate rejection, or a failure", () => {
    for (const outcome of ["alreadyBio", "gateSkipped", "skipped"] as const) {
      expect(
        bioCostEvent({ authored: AUTHORED, dryRun: false, outcome, slug: "calibre" }),
      ).toBeNull();
    }
  });

  test("records NOTHING when there is no authored bio", () => {
    expect(
      bioCostEvent({ authored: null, dryRun: false, outcome: "authored", slug: "calibre" }),
    ).toBeNull();
  });
});
