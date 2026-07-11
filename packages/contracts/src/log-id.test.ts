// Self-running checks for the canonical Log ID grammar — no framework (the
// util.test.ts / galaxy-slug.test.ts precedent). Run: `bun src/log-id.test.ts` (or
// `bun test`). Drives every case through the shared LOG_ID_TEST_VECTORS so the
// fixture that pins the TS mirrors (and the Go `looksLikeLogID` sibling) is itself
// asserted against the definition it fixtures.

import assert from "node:assert/strict";

import { COORDINATE_PATTERN, isLogId, isMixtapeLogId, LOG_ID_TEST_VECTORS } from "./log-id";

const { lowercase, malformed, validFindings, validMixtapes } = LOG_ID_TEST_VECTORS;

// The scheme scanner is a stateful global regex; scan with a fresh non-global clone so
// `lastIndex` never leaks between assertions. Returns the bare captured id, or null.
function scan(id: string): string | null {
  return `fluncle://${id}`.match(new RegExp(COORDINATE_PATTERN.source, "i"))?.[1] ?? null;
}

// Finding coordinates: a finding, not a mixtape, and the scanner pulls it back whole.
for (const id of validFindings) {
  assert.equal(isLogId(id), true, `${id} is a finding`);
  assert.equal(isMixtapeLogId(id), false, `${id} is not a mixtape`);
  assert.equal(scan(id), id, `${id} scans`);
}

// Mixtape coordinates: a mixtape, not a finding, and it scans.
for (const id of validMixtapes) {
  assert.equal(isMixtapeLogId(id), true, `${id} is a mixtape`);
  assert.equal(isLogId(id), false, `${id} is not a finding`);
  assert.equal(scan(id), id, `${id} scans`);
}

// Lowercase: the bare guards are case-SENSITIVE (canonical stored casing), but the
// scanner is case-insensitive by design and still finds it.
for (const id of lowercase) {
  assert.equal(isLogId(id), false, `${id} fails the case-sensitive finding guard`);
  assert.equal(isMixtapeLogId(id), false, `${id} fails the case-sensitive mixtape guard`);
  assert.equal(scan(id), id, `${id} is still found by the case-insensitive scanner`);
}

// Malformed: rejected by every surface — the bare guards and the scanner alike.
for (const id of malformed) {
  assert.equal(isLogId(id), false, `${id} is not a finding`);
  assert.equal(isMixtapeLogId(id), false, `${id} is not a mixtape`);
  assert.equal(scan(id), null, `${id} does not scan`);
}

// The scanner pulls a coordinate out of surrounding prose and stops at sentence
// punctuation (the mark never contains a dot).
assert.equal(
  "Listen: fluncle://004.7.2I and tell me".match(COORDINATE_PATTERN)?.[0],
  "fluncle://004.7.2I",
  "the scanner finds a coordinate in prose",
);
assert.equal(
  "found it: fluncle://007.0.0Z.".match(new RegExp(COORDINATE_PATTERN.source, "i"))?.[1],
  "007.0.0Z",
  "a trailing period is sentence punctuation, not part of the mark",
);

console.log("log-id grammar: all checks passed");
