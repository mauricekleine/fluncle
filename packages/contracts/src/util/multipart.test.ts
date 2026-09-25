import assert from "node:assert/strict";

import {
  buildCompleteXml,
  DEFAULT_PART_SIZE,
  MAX_PARTS,
  MIN_PART_SIZE,
  planMultipart,
} from "./multipart";

{
  const plan = planMultipart(123);

  assert.equal(plan.partCount, 1);
  assert.deepEqual(plan.parts, [{ end: 123, partNumber: 1, size: 123, start: 0 }]);
}

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

{
  const plan = planMultipart(MIN_PART_SIZE * 3, 1024);

  assert.equal(plan.partSize, MIN_PART_SIZE);
  assert.equal(plan.partCount, 3);
}

{
  const huge = DEFAULT_PART_SIZE * (MAX_PARTS + 100);
  const plan = planMultipart(huge);

  assert.ok(plan.partCount <= MAX_PARTS, `part count over cap: ${plan.partCount}`);
  assert.ok(plan.partSize > DEFAULT_PART_SIZE, "part size must grow past the default");
}

{
  const plan = planMultipart(1_600_000_000);

  assert.ok(plan.partCount <= MAX_PARTS);
  assert.equal(plan.parts.at(-1)?.end, 1_600_000_000);
}

{
  for (const bad of [0, -5, 1.5]) {
    assert.throws(() => planMultipart(bad), /positive integer/, `should reject ${bad}`);
  }
}

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

console.log("multipart.test.ts: all checks passed");
