// Self-running check for the social caption builder — no framework. This copy
// ships to every social platform and encodes VOICE.md rules (the one sanctioned
// em dash, the "Found" stamp, graceful degradation), so the invariants below are
// load-bearing. Run: `bun src/pipeline/caption.test.ts` (exits non-zero on fail).

import assert from "node:assert/strict";

import { buildCaption, type CaptionTrack, formatFound, yearFromReleaseDate } from "./caption";

const base: CaptionTrack = {
  addedAt: "2026-06-08T12:00:00Z",
  artists: ["Artist One"],
  logId: "001.1.1A",
  title: "The Title",
};

// 1. With a year: the title line carries "(Year)" and the one sanctioned em dash.
{
  const out = buildCaption(base, 2015);
  assert.ok(out.startsWith("Artist One — The Title (2015)\n"), `year line: ${out}`);
  assert.ok(out.includes(" — "), "the sanctioned em dash must be present");
}

// 2. Without a year: no parenthetical, still the em dash.
{
  const out = buildCaption(base, null);
  assert.ok(out.startsWith("Artist One — The Title\n"), `no-year line: ${out}`);
  assert.ok(!out.includes("("), "no parenthetical when year is null");
}

// 3. Label present → its own line right under the title.
{
  const out = buildCaption({ ...base, label: "Hospital Records" }, null);
  const lines = out.split("\n");
  assert.equal(lines[0], "Artist One — The Title");
  assert.equal(lines[1], "Hospital Records", "label is the second line");
}

// 4. Label absent (and blank/whitespace) → no label line.
{
  const noLabel = buildCaption(base, null).split("\n");
  assert.equal(noLabel[1], "", "no label line → the blank separator follows the title");

  const blankLabel = buildCaption({ ...base, label: "   " }, null).split("\n");
  assert.equal(blankLabel[1], "", "a whitespace-only label is dropped (trimmed away)");
}

// 5. Multi-artist join uses ", ".
{
  const out = buildCaption(
    { ...base, artists: ["Artist One", "Artist Two", "Artist Three"] },
    null,
  );
  assert.ok(out.startsWith("Artist One, Artist Two, Artist Three — The Title\n"), out);
}

// 6. The "Found <date>" stamp is UTC with no leading zero — and it must NOT flip
//    the day for a near-midnight UTC instant regardless of the host timezone.
{
  // 23:00Z on Jun 8: in any positive-offset zone (e.g. CEST, UTC+2) the LOCAL
  // day is Jun 9. Using UTC keeps it Jun 8. This proves the UTC reads.
  const out = buildCaption({ ...base, addedAt: "2026-06-08T23:00:00Z" }, null);
  assert.ok(out.includes("Found Jun 8: fluncle://001.1.1A"), `boundary stamp: ${out}`);

  // 00:30Z on Jun 1: in any negative-offset zone the LOCAL day is May 31.
  const early = formatFound("2026-06-01T00:30:00Z");
  assert.equal(early, "Found Jun 1", "early-UTC boundary stays Jun 1, no leading zero");

  // Direct: no leading zero on a single-digit day.
  assert.equal(formatFound("2026-01-05T12:00:00Z"), "Found Jan 5", "no leading zero on the day");
}

// 7. Invalid date → graceful "Found" (no NaN month / day in the copy).
{
  const stamp = formatFound("not-a-date");
  assert.equal(stamp, "Found", "garbage date degrades to a bare 'Found'");
  const out = buildCaption({ ...base, addedAt: "garbage" }, null);
  assert.ok(out.includes("Found: fluncle://001.1.1A"), `graceful caption: ${out}`);
  assert.ok(!out.includes("NaN") && !out.includes("undefined"), "no NaN/undefined leaks into copy");
}

// 8. Missing logId → throw (every video needs a coordinate).
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

// 9. The fixed D&B hashtag base is the final line.
{
  const out = buildCaption(base, null);
  assert.ok(out.endsWith("#dnb #drumnbass #drumandbass\n"), `hashtag tail: ${out}`);
}

// 10. yearFromReleaseDate: parses the leading year, null on empty/garbage.
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
