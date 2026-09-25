import assert from "node:assert/strict";

import { COORDINATE_PATTERN, isLogId, isMixtapeLogId, LOG_ID_TEST_VECTORS } from "./log-id";

const { lowercase, malformed, validFindings, validMixtapes } = LOG_ID_TEST_VECTORS;

function scan(id: string): string | null {
  return `fluncle://${id}`.match(new RegExp(COORDINATE_PATTERN.source, "i"))?.[1] ?? null;
}

for (const id of validFindings) {
  assert.equal(isLogId(id), true, `${id} is a finding`);
  assert.equal(isMixtapeLogId(id), false, `${id} is not a mixtape`);
  assert.equal(scan(id), id, `${id} scans`);
}

for (const id of validMixtapes) {
  assert.equal(isMixtapeLogId(id), true, `${id} is a mixtape`);
  assert.equal(isLogId(id), false, `${id} is not a finding`);
  assert.equal(scan(id), id, `${id} scans`);
}

for (const id of lowercase) {
  assert.equal(isLogId(id), false, `${id} fails the case-sensitive finding guard`);
  assert.equal(isMixtapeLogId(id), false, `${id} fails the case-sensitive mixtape guard`);
  assert.equal(scan(id), id, `${id} is still found by the case-insensitive scanner`);
}

for (const id of malformed) {
  assert.equal(isLogId(id), false, `${id} is not a finding`);
  assert.equal(isMixtapeLogId(id), false, `${id} is not a mixtape`);
  assert.equal(scan(id), null, `${id} does not scan`);
}

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
