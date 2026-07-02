// Self-running checks for the strict intent validator. A valid stub passes with no
// errors; malformed intents surface PRECISE per-field errors (the whole point — the
// runtime validator only says null). Also proves the optional doctrine fields
// (register "framed", depthMechanism, focalPoint) validate when present.

import assert from "node:assert/strict";

import { generateIntentStub, RENDER_INTENT_SCHEMA } from "./intent";
import { validateIntentStrict } from "./validate-intent";

// A minimal valid intent (the ship-time stub) must pass strict validation.
const stub = generateIntentStub("track123", "004.9.9Z");
const okResult = validateIntentStrict(stub);
assert.equal(
  okResult.valid,
  true,
  `the generated stub must be strictly valid: ${JSON.stringify(okResult.errors)}`,
);
assert.equal(okResult.errors.length, 0, "a valid stub has zero errors");

// Optional doctrine fields validate when present.
const withDoctrine = {
  ...stub,
  depthMechanism: "parallax layers",
  focalPoint: "centre bloom",
  register: "framed" as const,
};
assert.equal(
  validateIntentStrict(withDoctrine).valid,
  true,
  "the framed register + doctrine fields are valid",
);

// A bad schema string is caught with the exact path.
const badSchema = validateIntentStrict({ ...stub, schema: "nope" });
assert.equal(badSchema.valid, false, "a wrong schema is invalid");
assert.ok(
  badSchema.errors.some((e) => e.path === "schema"),
  "the schema error names the schema path",
);

// Multiple field errors are collected (not fail-fast): bad enum, bad dropMs, bad binding.
const messy = validateIntentStrict({
  arcSource: "energyCurve",
  bindings: [{ axis: "warpAmp", band: "kickHit", element: "e", intendedStrength: "loud" }], // bad band + strength
  climax: { atMs: 0, colour: "y", form: "x" },
  concept: "c",
  dropMs: -5, // negative
  logId: null,
  motionModel: "constant-drift",
  register: "abstract",
  schema: RENDER_INTENT_SCHEMA,
  textureFamily: "glitter", // invalid enum
  trackId: "t",
  vehicle: "v",
});
assert.equal(messy.valid, false, "a messy intent is invalid");
const paths = messy.errors.map((e) => e.path);
assert.ok(paths.includes("textureFamily"), "the bad textureFamily enum is flagged");
assert.ok(paths.includes("dropMs"), "the negative dropMs is flagged");
assert.ok(paths.includes("bindings[0].band"), "the unknown band is flagged with its index path");
assert.ok(paths.includes("bindings[0].intendedStrength"), "the bad strength is flagged");
assert.ok(messy.errors.length >= 4, "all four violations are collected, not fail-fast");

// A non-object is rejected cleanly.
assert.equal(validateIntentStrict(null).valid, false, "null is invalid");
assert.equal(validateIntentStrict(42).valid, false, "a number is invalid");

console.log(
  `validate-intent: stub=valid framed=valid badSchema=${badSchema.errors.length}err messy=${messy.errors.length}err(${paths.join(",")})`,
);
console.log(
  "✓ validate-intent: valid stub passes, framed register + doctrine fields pass, malformed intents surface precise per-field errors",
);
