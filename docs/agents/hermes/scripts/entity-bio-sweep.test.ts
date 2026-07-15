// Unit tests for entity-bio-sweep.ts — specifically the COST-01 metering seam
// (`bioCostEvent`), the box scripts being self-contained (they cannot import the
// workspace) and living outside any package's test runner, so this file uses
// `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/entity-bio-sweep.test.ts
//
// The load-bearing behaviour under test: the ledger tracks DELIVERED work — a `bio`
// authoring-spend row is recorded ONLY when a bio was actually authored AND stored this
// tick, NEVER on a dry-run, an operator-bio no-op, a gate rejection, or a failure. Its
// shape mirrors note-sweep's `note` row exactly (subsidized/anthropic/tokens/measured),
// just with `step: "bio"` and the entity slug as the id scope.

import { describe, expect, test } from "bun:test";
import { costEventId } from "./cost-emit";
import { bioCostEvent } from "./entity-bio-sweep";

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
