import assert from "node:assert/strict";

import { buildCaption, type CaptionTrack, formatFound, yearFromReleaseDate } from "./caption";

const base: CaptionTrack = {
  addedAt: "2026-06-08T12:00:00Z",
  artists: ["Artist One"],
  logId: "001.1.1A",
  title: "The Title",
};

{
  const out = buildCaption(base, 2015);
  assert.ok(out.startsWith("Artist One — The Title (2015)\n"), `year line: ${out}`);
  assert.ok(out.includes(" — "), "the sanctioned em dash must be present");
}

{
  const out = buildCaption(base, null);
  assert.ok(out.startsWith("Artist One — The Title\n"), `no-year line: ${out}`);
  assert.ok(!out.includes("("), "no parenthetical when year is null");
}

{
  const out = buildCaption({ ...base, label: "Hospital Records" }, null);
  const lines = out.split("\n");
  assert.equal(lines[0], "Artist One — The Title");
  assert.equal(lines[1], "Hospital Records", "label is the second line");
}

{
  const noLabel = buildCaption(base, null).split("\n");
  assert.equal(noLabel[1], "", "no label line → the blank separator follows the title");

  const blankLabel = buildCaption({ ...base, label: "   " }, null).split("\n");
  assert.equal(blankLabel[1], "", "a whitespace-only label is dropped (trimmed away)");
}

{
  const out = buildCaption(
    { ...base, artists: ["Artist One", "Artist Two", "Artist Three"] },
    null,
  );
  assert.ok(out.startsWith("Artist One, Artist Two, Artist Three — The Title\n"), out);
}

{
  const out = buildCaption({ ...base, addedAt: "2026-06-08T23:00:00Z" }, null);
  assert.ok(out.includes("Found Jun 8: fluncle://001.1.1A"), `boundary stamp: ${out}`);

  const early = formatFound("2026-06-01T00:30:00Z");
  assert.equal(early, "Found Jun 1", "early-UTC boundary stays Jun 1, no leading zero");

  assert.equal(formatFound("2026-01-05T12:00:00Z"), "Found Jan 5", "no leading zero on the day");
}

{
  const stamp = formatFound("not-a-date");
  assert.equal(stamp, "Found", "garbage date degrades to a bare 'Found'");
  const out = buildCaption({ ...base, addedAt: "garbage" }, null);
  assert.ok(out.includes("Found: fluncle://001.1.1A"), `graceful caption: ${out}`);
  assert.ok(!out.includes("NaN") && !out.includes("undefined"), "no NaN/undefined leaks into copy");
}

{
  assert.throws(
    () => buildCaption({ ...base, logId: null }, null),
    /no Log ID/,
    "a caption without a Log ID must throw",
  );
  assert.throws(
    () => buildCaption({ ...base, logId: undefined }, null),
    /no Log ID/,
    "an undefined Log ID must throw too",
  );
}

{
  const out = buildCaption(base, null);
  assert.ok(out.endsWith("#dnb #drumnbass #drumandbass\n"), `hashtag tail: ${out}`);
}

{
  assert.equal(yearFromReleaseDate("2015-03-20"), 2015);
  assert.equal(yearFromReleaseDate("1998"), 1998);
  assert.equal(yearFromReleaseDate(null), null);
  assert.equal(yearFromReleaseDate(undefined), null);
  assert.equal(yearFromReleaseDate(""), null);
  assert.equal(yearFromReleaseDate("notayear"), null, "non-numeric year → null");
}

console.log(
  "✓ caption: year/label/multi-artist join, UTC no-leading-zero Found stamp, graceful + throws",
);
