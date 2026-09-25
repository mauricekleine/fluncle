import assert from "node:assert/strict";

import { MB_LABEL_MBID_PATTERN, MintLabelOutcomeSchema, mintLabel } from "./admin-labels";
import { adminLabelsContract } from "./admin-labels";

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

{
  for (const mbLabelId of [
    "",
    "med-school",
    "lbl_4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2",
    "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f",
    "4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2x",
    "4cbb2ba14e0a4a6e8f3d5e17a4c0a1f2",
    "zzzzzzzz-4e0a-4a6e-8f3d-5e17a4c0a1f2",
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

{
  assert.equal(MB_LABEL_MBID_PATTERN.test("4cbb2ba1-4e0a-4a6e-8f3d-5e17a4c0a1f2"), true);
  assert.equal(MB_LABEL_MBID_PATTERN.test("not-an-mbid"), false);
}

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

{
  const isOutcome = (value: unknown): boolean =>
    (MintLabelOutcomeSchema["~standard"].validate(value) as { issues?: readonly unknown[] })
      .issues === undefined;

  for (const outcome of ["minted", "adopted", "known", "taken_over"]) {
    assert.equal(isOutcome(outcome), true, `${outcome} is an outcome`);
  }

  assert.equal(isOutcome("takenover"), false, "the outcome set is closed");
}

{
  assert.equal(adminLabelsContract.mint_label, mintLabel, "registered as mint_label");

  const route = mintLabel["~orpc"].route;

  assert.equal(route.method, "POST");
  assert.equal(route.path, "/admin/labels");
  assert.equal(route.operationId, "mintLabel");
}
