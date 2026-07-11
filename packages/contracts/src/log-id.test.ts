// Self-running checks for the canonical Log ID grammar — no framework (the
// util.test.ts / galaxy-slug.test.ts precedent). Run: `bun src/log-id.test.ts` (or
// `bun test`). Drives every case through the shared LOG_ID_TEST_VECTORS so the
// fixture that pins the TS mirrors (and the Go `looksLikeLogID` sibling) is itself
// asserted against the definition it fixtures.

import assert from "node:assert/strict";

import {
  COORDINATE_PATTERN,
  isEditionLogId,
  isLogId,
  isMixtapeLogId,
  LOG_ID_TEST_VECTORS,
} from "./log-id";

const { lowercase, malformed, validEditions, validFindings, validMixtapes } = LOG_ID_TEST_VECTORS;

// The scheme scanner is a stateful global regex; scan with a fresh non-global clone so
// `lastIndex` never leaks between assertions. Returns the bare captured id, or null.
function scan(id: string): string | null {
  return `fluncle://${id}`.match(new RegExp(COORDINATE_PATTERN.source, "i"))?.[1] ?? null;
}

// THE RAIL: exactly one of the three guards may claim any coordinate. The /log
// resolver branches on these, so an id two guards accept would serve a visitor the
// wrong KIND of object — a finding shown as a letter, a letter shown as a mixtape.
// The marker slot (digit / `F` / `L`) is what keeps them disjoint; assert it holds.
function assertExactlyOneKind(id: string, expected: "edition" | "finding" | "mixtape" | "none") {
  const claimed = [
    isLogId(id) ? "finding" : undefined,
    isMixtapeLogId(id) ? "mixtape" : undefined,
    isEditionLogId(id) ? "edition" : undefined,
  ].filter((kind) => kind !== undefined);

  assert.deepEqual(
    claimed,
    expected === "none" ? [] : [expected],
    `${id} is claimed by exactly the ${expected} guard`,
  );
}

// Finding coordinates: a finding and nothing else, and the scanner pulls it back whole.
for (const id of validFindings) {
  assertExactlyOneKind(id, "finding");
  assert.equal(scan(id), id, `${id} scans`);
}

// Mixtape coordinates: a mixtape and nothing else, and it scans.
for (const id of validMixtapes) {
  assertExactlyOneKind(id, "mixtape");
  assert.equal(scan(id), id, `${id} scans`);
}

// Edition coordinates (the `.L.` letter): an edition and nothing else, and it scans.
for (const id of validEditions) {
  assertExactlyOneKind(id, "edition");
  assert.equal(scan(id), id, `${id} scans`);
}

// Lowercase: the bare guards are case-SENSITIVE (canonical stored casing), but the
// scanner is case-insensitive by design and still finds it.
for (const id of lowercase) {
  assertExactlyOneKind(id, "none");
  assert.equal(scan(id), id, `${id} is still found by the case-insensitive scanner`);
}

// Malformed: rejected by every surface — the bare guards and the scanner alike.
for (const id of malformed) {
  assertExactlyOneKind(id, "none");
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
