// Self-running checks for the archive's pure helpers — no framework, mirroring the
// repo's node:assert-free style (submit-fault.test.ts / media.test.ts). Run via
// `bun test` (reports "0 pass" — no describe/it blocks — but throws and fails the
// process on any failed assertion) or `bun src/lib/archive-state.test.ts`.
//
// These pin the two things the design critique flagged: the three-way state branch
// (so "Quiet sector." can't render on a cold start or a network failure), and the
// title-survives-truncation contract (so a long artist list can't delete the title).

import { archiveView, findingLineParts, findingMetaSegments } from "@/lib/archive-state";

// A tiny strict-equality assertion (see submit-fault.test.ts): framework- and
// dependency-free, still throws (and fails the `bun test` process) on a mismatch.
function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. The three-way (four-way) state branch — the B2 blocker.
//    A cold start is loading, NOT empty.
assertEqual(
  archiveView({ count: 0, isError: false, isPending: true }),
  "loading",
  "cold start (pending, no data) → loading, never empty",
);
// A first-load failure with nothing to show is an honest error, NOT empty.
assertEqual(
  archiveView({ count: 0, isError: true, isPending: false }),
  "error",
  "first-load failure with no data → error, never empty",
);
// A genuinely empty result is the only thing that shows the quiet-sector line.
assertEqual(
  archiveView({ count: 0, isError: false, isPending: false }),
  "empty",
  "settled, no data, no error → empty",
);
// Any findings render the list.
assertEqual(
  archiveView({ count: 3, isError: false, isPending: false }),
  "list",
  "findings present → list",
);
// Data wins over a later error: a background refetch failure never nukes the list.
assertEqual(
  archiveView({ count: 3, isError: true, isPending: false }),
  "list",
  "data present + background error → still list, never error",
);

// 2. The title survives truncation — the H3 fix. The title comes back WHOLE no
//    matter how long the artist list is, so the row (artist flexShrink:1, title
//    flexShrink:0) can never delete it.
const shortArtist = findingLineParts(["Submotion Orchestra"], "All Yours");
assertEqual(shortArtist.artists, "Submotion Orchestra", "single artist joins to itself");
assertEqual(shortArtist.title, "All Yours", "title returned whole (short artist)");

const longArtist = findingLineParts(
  ["Submotion Orchestra", "Ruby Wood", "Some Very Long Guest Vocalist Name", "And Another"],
  "All Yours",
);
assertEqual(
  longArtist.title,
  "All Yours",
  "title is IDENTICAL and whole even with a long artist list (never truncated in the data path)",
);
assertEqual(
  longArtist.artists,
  "Submotion Orchestra, Ruby Wood, Some Very Long Guest Vocalist Name, And Another",
  "artists join with ', ' (the shrinkable half)",
);

// 3. The meta line's segments — BPM/key are numeric (tabular face), galaxy is prose.
const full = findingMetaSegments({ bpm: 174.4, galaxyName: "Solar", key: "5A" });
assertEqual(full.length, 3, "bpm + key + galaxy → three segments");
assertEqual(full[0]?.text, "174 BPM", "bpm rounds and carries its unit");
assertEqual(full[0]?.numeric, true, "bpm is a figure → numeric");
assertEqual(full[1]?.text, "5A", "key passes through");
assertEqual(full[1]?.numeric, true, "key is a figure → numeric");
assertEqual(full[2]?.text, "Solar", "galaxy name passes through");
assertEqual(full[2]?.numeric, false, "galaxy name is prose → not numeric");

// Empty fields drop out entirely (no dangling separator around a missing value).
assertEqual(
  findingMetaSegments({ bpm: null, galaxyName: null, key: null }).length,
  0,
  "no fields → no segments",
);
assertEqual(
  findingMetaSegments({ bpm: 128, galaxyName: null, key: null }).length,
  1,
  "only bpm → one segment",
);
