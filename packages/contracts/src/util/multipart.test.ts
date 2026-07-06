// Self-running checks for the shared multipart plan + completion XML — no framework
// (the contracts package convention; see galaxy-slug.test.ts). Run: `bun test`.
//
// This is the ONE source of truth the CLI (`Bun.file().slice()`) and the browser
// (`File.slice()`) both drive, so the part-splitting invariants — contiguous + gapless
// coverage, the 5MB floor, the 10k-part cap growth — are guarded here for both.

import assert from "node:assert/strict";

import {
  buildCompleteXml,
  DEFAULT_PART_SIZE,
  MAX_PARTS,
  MIN_PART_SIZE,
  planMultipart,
} from "./multipart";

// 1. A sub-part-size file is a single part covering the whole range.
{
  const plan = planMultipart(123);

  assert.equal(plan.partCount, 1);
  assert.deepEqual(plan.parts, [{ end: 123, partNumber: 1, size: 123, start: 0 }]);
}

// 2. Splits into contiguous, gapless, ascending parts that cover every byte.
{
  const unit = MIN_PART_SIZE;
  const total = unit * 2 + 7;
  const plan = planMultipart(total, unit);

  assert.equal(plan.partCount, 3);
  assert.deepEqual(plan.parts, [
    { end: unit, partNumber: 1, size: unit, start: 0 },
    { end: unit * 2, partNumber: 2, size: unit, start: unit },
    { end: total, partNumber: 3, size: 7, start: unit * 2 },
  ]);

  let cursor = 0;

  for (const part of plan.parts) {
    assert.equal(part.start, cursor, "parts must be contiguous");
    cursor = part.end;
  }

  assert.equal(cursor, total, "parts must cover the whole file");
}

// 3. The requested part size is floored at R2's 5MB minimum.
{
  const plan = planMultipart(MIN_PART_SIZE * 3, 1024);

  assert.equal(plan.partSize, MIN_PART_SIZE);
  assert.equal(plan.partCount, 3);
}

// 4. A file too big for 10k default parts grows the part size instead of overflowing the cap.
{
  const huge = DEFAULT_PART_SIZE * (MAX_PARTS + 100);
  const plan = planMultipart(huge);

  assert.ok(plan.partCount <= MAX_PARTS, `part count over cap: ${plan.partCount}`);
  assert.ok(plan.partSize > DEFAULT_PART_SIZE, "part size must grow past the default");
}

// 5. A ~1.6GB set fits comfortably under the cap and the last part ends exactly at EOF.
{
  const plan = planMultipart(1_600_000_000);

  assert.ok(plan.partCount <= MAX_PARTS);
  assert.equal(plan.parts.at(-1)?.end, 1_600_000_000);
}

// 6. A non-positive or non-integer length is rejected.
{
  for (const bad of [0, -5, 1.5]) {
    assert.throws(() => planMultipart(bad), /positive integer/, `should reject ${bad}`);
  }
}

// 7. The completion XML emits parts in ascending order with escaped ETags.
{
  const xml = buildCompleteXml([
    { etag: '"e2"', partNumber: 2 },
    { etag: '"e1"', partNumber: 1 },
  ]);

  assert.equal(
    xml,
    "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part>" +
      "<Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part></CompleteMultipartUpload>",
  );
  assert.ok(
    buildCompleteXml([{ etag: 'a&b<c>"d', partNumber: 1 }]).includes("a&amp;b&lt;c&gt;&quot;d"),
  );
  assert.equal(buildCompleteXml([]), "<CompleteMultipartUpload></CompleteMultipartUpload>");
}

// eslint-disable-next-line no-console
console.log("multipart.test.ts: all checks passed");
