import assert from "node:assert/strict";

import { generateIntentStub, RENDER_INTENT_SCHEMA } from "./intent";
import { validateIntentStrict } from "./validate-intent";

const stub = generateIntentStub("track123", "004.9.9Z");
const okResult = validateIntentStrict(stub);
assert.equal(
  okResult.valid,
  true,
  `the generated stub must be strictly valid: ${JSON.stringify(okResult.errors)}`,
);
assert.equal(okResult.errors.length, 0, "a valid stub has zero errors");

assert.equal(
  stub.register,
  "representational",
  "the stub seeds the representational register, not the retired abstract",
);

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

assert.equal(stub.subjectClass, "none", "the stub declares the honest no-subject class");

const presence = {
  ...stub,
  bindings: [
    { axis: "density", band: "bass", element: "fog", intendedStrength: "strong" },
    { axis: "ignition", band: "drop", element: "key shaft", intendedStrength: "strong" },
    { axis: "grain", band: "treble", element: "emulsion", intendedStrength: "subtle" },
  ],
  disclosure: "resolved-at-drop" as const,
  register: "representational" as const,
  subjectClass: "colossus" as const,
  subjectClock: "constant" as const,
  viewpoint: "passage" as const,
};
const presenceResult = validateIntentStrict(presence);
assert.equal(
  presenceResult.valid,
  true,
  `a well-formed presence intent is valid: ${JSON.stringify(presenceResult.errors)}`,
);

const badClass = validateIntentStrict({ ...stub, subjectClass: "leviathan" });
assert.equal(badClass.valid, false, "an unknown subjectClass is invalid");
assert.ok(
  badClass.errors.some((e) => e.path === "subjectClass"),
  "the subjectClass error names the subjectClass path",
);

const noDropBinding = validateIntentStrict({
  ...stub,
  bindings: [{ axis: "density", band: "bass", element: "fog", intendedStrength: "strong" }],
  disclosure: "resolved-at-drop",
});
assert.equal(noDropBinding.valid, false, "resolved-at-drop needs a drop binding");
assert.ok(
  noDropBinding.errors.some((e) => e.path === "disclosure"),
  "the missing-drop-binding error names disclosure",
);

const subjectTranslates = validateIntentStrict({
  ...stub,
  bindings: [
    { axis: "translation", band: "swell", element: "the hull", intendedStrength: "strong" },
  ],
  subjectClass: "vessel",
});
assert.equal(
  subjectTranslates.valid,
  false,
  "a present subject may not carry a translation binding",
);
assert.ok(
  subjectTranslates.errors.some((e) => e.path === "bindings"),
  "the translation-on-a-subject error names bindings",
);

const clockTranslates = validateIntentStrict({
  ...stub,
  bindings: [
    { axis: "translation", band: "energy", element: "camera", intendedStrength: "subtle" },
  ],
  subjectClock: "biological",
});
assert.equal(
  clockTranslates.valid,
  false,
  "a declared subjectClock also forbids translation bindings",
);

const abstractTranslates = validateIntentStrict({
  ...stub,
  bindings: [{ axis: "translation", band: "swell", element: "field", intendedStrength: "subtle" }],
  subjectClass: "none",
});
assert.equal(abstractTranslates.valid, true, "an abstract field may translate on a smoothed band");

const badSchema = validateIntentStrict({ ...stub, schema: "nope" });
assert.equal(badSchema.valid, false, "a wrong schema is invalid");
assert.ok(
  badSchema.errors.some((e) => e.path === "schema"),
  "the schema error names the schema path",
);

const messy = validateIntentStrict({
  arcSource: "energyCurve",
  bindings: [{ axis: "warpAmp", band: "kickHit", element: "e", intendedStrength: "loud" }],
  climax: { atMs: 0, colour: "y", form: "x" },
  concept: "c",
  dropMs: -5,
  logId: null,
  motionModel: "constant-drift",
  register: "abstract",
  schema: RENDER_INTENT_SCHEMA,
  textureFamily: "glitter",
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

assert.equal(validateIntentStrict(null).valid, false, "null is invalid");
assert.equal(validateIntentStrict(42).valid, false, "a number is invalid");

console.log(
  `validate-intent: stub=valid framed=valid badSchema=${badSchema.errors.length}err messy=${messy.errors.length}err(${paths.join(",")})`,
);
console.log(
  "✓ validate-intent: valid stub passes, framed register + doctrine fields pass, malformed intents surface precise per-field errors",
);
