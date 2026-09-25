import assert from "node:assert/strict";

import { normalize, similarity } from "./resolve-preview";

const FLOOR = 0.6;

assert.equal(similarity("Pendulum", "Pendulum"), 1, "identical → 1");
assert.equal(similarity("The Nine", "the nine"), 1, "case-folded identical → 1");

assert.equal(similarity("abc", "xyz"), 0, "disjoint → 0");

assert.equal(similarity("", "anything"), 0, "empty left → 0");
assert.equal(similarity("(feat. Someone)", "anything"), 0, "normalizes-to-empty → 0");

{
  const close = similarity("Tarantula", "Tarantela");
  assert.ok(close >= FLOOR, `a one-letter typo should clear the floor (got ${close})`);

  const far = similarity("Tarantula", "Watercolour");
  assert.ok(far < FLOOR, `an unrelated title must stay below the floor (got ${far})`);
}

{
  const closer = similarity("Voodoo People", "Voodoo People (Remix)");
  const looser = similarity("Voodoo People", "Smack My Bitch Up");
  assert.ok(closer > looser, `closer candidate must win (${closer} vs ${looser})`);
  assert.ok(closer >= FLOOR, `'(Remix)' is stripped, so the core title still clears (${closer})`);
}

assert.equal(normalize("Björk"), "bjork", "diacritics stripped");
assert.equal(normalize("Sigur Rós"), "sigur ros", "diacritics stripped (accented o)");

assert.equal(
  normalize("Breathe (feat. Stamina MC)"),
  "breathe",
  "parenthetical feat-credit removed",
);
assert.equal(normalize("Inner City Life [Original Mix]"), "inner city life", "bracket tag removed");

assert.equal(normalize("  Hyper-Real!!  "), "hyper real", "punctuation collapses, trims");
assert.equal(normalize("AC/DC"), "ac dc", "slash becomes a separator");

console.log(
  "✓ resolve-preview: Dice scorer (1/0/floor boundary, monotonic) + normalize (diacritics, feat/brackets)",
);
