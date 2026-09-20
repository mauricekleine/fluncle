// Self-running check for the `mint_label` contract shape — no framework, the `devices.test.ts`
// style. This op is the second load-bearing REJECTING contract on the admin surface: its ONLY input
// is an identity, so a malformed MBID must 400 at the edge rather than spend one of MusicBrainz's
// 1 req/s slots proving a typo is a typo. The `seedState` half is asserted OPTIONAL on purpose —
// that is the property that stops a re-run from un-ruling a label the operator already enabled.
// Run: `bun src/orpc/admin-labels.test.ts`.

import assert from "node:assert/strict";

import { MB_LABEL_MBID_PATTERN, MintLabelOutcomeSchema, mintLabel } from "./admin-labels";
import { adminLabelsContract } from "./admin-labels";

/** The op's input validator, reached the same way the coverage tests reach a route. */
const input = mintLabel["~orpc"].inputSchema;

function parse(value: unknown) {
  if (!input) {
    throw new Error("mint_label declares no input schema");
  }

  return input["~standard"].validate(value) as { issues?: readonly unknown[] };
}

function accepts(value: unknown): boolean {
  return parse(value).issues === undefined;
}

// 1. A well-formed MusicBrainz MBID is accepted, with and without a ruling.
{
  const mbid = "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2";

  assert.equal(accepts({ mbLabelId: mbid }), true, "a bare MBID is enough");
  assert.equal(
    accepts({ mbLabelId: mbid, seedState: "enabled" }),
    true,
    "enabled rules on arrival",
  );
  assert.equal(accepts({ mbLabelId: mbid.toUpperCase() }), true, "MBID case is not identity");
}

// 2. Anything that is not an MBID is rejected at the edge.
{
  for (const mbLabelId of [
    "", // empty
    "med-school", // a slug, the id the operator reaches for by habit
    "lbl_4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2", // Fluncle's own id, not MusicBrainz's
    "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f", // one hex short
    "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2x", // trailing junk
    "4cbb2ba14e0a4a6e8f3d5e17a4c0a1f2", // unhyphenated
    "zzzzzzzz-4e0a-4a6e-8f3d-5e17a4c0a1f2", // non-hex
  ]) {
    assert.equal(accepts({ mbLabelId }), false, `reject ${JSON.stringify(mbLabelId)}`);
  }

  assert.equal(accepts({}), false, "the identity is required");
  assert.equal(
    accepts({ mbLabelId: "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2", seedState: "maybe" }),
    false,
    "a seed state outside the ruling set is rejected",
  );
}

// 3. The pattern is exported so the CLI can refuse a typo without a round trip, and it is the
//    same shape both sides test against.
{
  assert.equal(MB_LABEL_MBID_PATTERN.test("4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2"), true);
  assert.equal(MB_LABEL_MBID_PATTERN.test("not-an-mbid"), false);
}

// 3b. `takeOverSlug` is OPTIONAL and must carry a slug when present — the identity re-point is
//     never inferred, it is always the operator saying which row to move, out loud.
{
  const mbid = "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2";

  assert.equal(accepts({ mbLabelId: mbid }), true, "the take-over is opt-in");
  assert.equal(
    accepts({ mbLabelId: mbid, takeOverSlug: "med-school" }),
    true,
    "a slug names the row whose identity moves",
  );
  assert.equal(
    accepts({ mbLabelId: mbid, seedState: "enabled", takeOverSlug: "med-school" }),
    true,
    "a take-over may rule the new identity in the same call",
  );
  assert.equal(accepts({ mbLabelId: mbid, takeOverSlug: "" }), false, "an empty slug names nobody");
  assert.equal(accepts({ mbLabelId: mbid, takeOverSlug: 7 }), false, "the slug is a string");
}

// 3c. `taken_over` is a first-class outcome beside the original three, so a client can tell an
//     identity RE-POINT from a fresh mint or an adoption.
{
  const isOutcome = (value: unknown): boolean =>
    (MintLabelOutcomeSchema["~standard"].validate(value) as { issues?: readonly unknown[] })
      .issues === undefined;

  for (const outcome of ["minted", "adopted", "known", "taken_over"]) {
    assert.equal(isOutcome(outcome), true, `${outcome} is an outcome`);
  }

  assert.equal(isOutcome("takenover"), false, "the outcome set is closed");
}

// 4. The op is registered under its canonical `verb_noun` key, at the collection-level route the
//    convention derives (`POST /admin/labels`), with the camelCase `operationId`.
{
  assert.equal(adminLabelsContract.mint_label, mintLabel, "registered as mint_label");

  const route = mintLabel["~orpc"].route;

  assert.equal(route.method, "POST");
  assert.equal(route.path, "/admin/labels");
  assert.equal(route.operationId, "mintLabel");
}
