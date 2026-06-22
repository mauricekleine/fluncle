// Self-running check for the preview-similarity gate — no framework. A fetched
// preview must be the RIGHT track: a wrong preview → wrong BPM → wrong-tempo
// video. The Dice scorer + normalizer below decide whether a candidate clears
// the CONFIDENCE_FLOOR (0.6). Run: `bun src/pipeline/resolve-preview.test.ts`.

import assert from "node:assert/strict";

import { normalize, similarity } from "./resolve-preview";

const FLOOR = 0.6;

// 1. Identical strings → 1 (exact-match short-circuit).
assert.equal(similarity("Pendulum", "Pendulum"), 1, "identical → 1");
assert.equal(similarity("The Nine", "the nine"), 1, "case-folded identical → 1");

// 2. Disjoint strings → 0 (no shared bigrams).
assert.equal(similarity("abc", "xyz"), 0, "disjoint → 0");

// 3. Empty / whitespace-only after normalize → 0 (never a false match).
assert.equal(similarity("", "anything"), 0, "empty left → 0");
assert.equal(similarity("(feat. Someone)", "anything"), 0, "normalizes-to-empty → 0");

// 4. Near-misses around the 0.6 floor. A close typo clears it; a loose pairing
//    does not. These guard the wrong-track regression directly.
{
  const close = similarity("Tarantula", "Tarantela");
  assert.ok(close >= FLOOR, `a one-letter typo should clear the floor (got ${close})`);

  const far = similarity("Tarantula", "Watercolour");
  assert.ok(far < FLOOR, `an unrelated title must stay below the floor (got ${far})`);
}

// 5. Monotonic-ish sanity: a closer candidate scores higher than a looser one.
{
  const closer = similarity("Voodoo People", "Voodoo People (Remix)");
  const looser = similarity("Voodoo People", "Smack My Bitch Up");
  assert.ok(closer > looser, `closer candidate must win (${closer} vs ${looser})`);
  assert.ok(closer >= FLOOR, `'(Remix)' is stripped, so the core title still clears (${closer})`);
}

// 6. normalize: strips diacritics.
assert.equal(normalize("Björk"), "bjork", "diacritics stripped");
assert.equal(normalize("Sigur Rós"), "sigur ros", "diacritics stripped (accented o)");

// 7. normalize: drops "(feat. …)" and "[…]" bracketed content.
assert.equal(
  normalize("Breathe (feat. Stamina MC)"),
  "breathe",
  "parenthetical feat-credit removed",
);
assert.equal(normalize("Inner City Life [Original Mix]"), "inner city life", "bracket tag removed");

// 8. normalize: collapses punctuation/whitespace to single spaces, trims, lowercases.
assert.equal(normalize("  Hyper-Real!!  "), "hyper real", "punctuation collapses, trims");
assert.equal(normalize("AC/DC"), "ac dc", "slash becomes a separator");

console.log(
  "✓ resolve-preview: Dice scorer (1/0/floor boundary, monotonic) + normalize (diacritics, feat/brackets)",
);
