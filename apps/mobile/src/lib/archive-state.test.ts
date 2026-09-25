import {
  archiveCopy,
  archiveView,
  findingLineParts,
  findingMetaSegments,
} from "@/lib/archive-state";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(actual: boolean, message = "assertion failed"): void {
  if (!actual) {
    throw new Error(message);
  }
}

assertEqual(
  archiveView({ count: 0, isError: false, isPaused: false, isPending: true }),
  "loading",
  "cold start (pending, no data) → loading, never empty",
);

assertEqual(
  archiveView({ count: 0, isError: true, isPaused: false, isPending: false }),
  "error",
  "first-load failure with no data → error, never empty",
);

assertEqual(
  archiveView({ count: 0, isError: false, isPaused: false, isPending: false }),
  "empty",
  "settled, no data, no error → empty",
);

assertEqual(
  archiveView({ count: 3, isError: false, isPaused: false, isPending: false }),
  "list",
  "findings present → list",
);

assertEqual(
  archiveView({ count: 3, isError: true, isPaused: false, isPending: false }),
  "list",
  "data present + background error → still list, never error",
);

assertEqual(
  archiveView({ count: 0, isError: false, isPaused: true, isPending: true }),
  "offline",
  "paused + pending + no data → offline, never loading",
);
assertEqual(
  archiveView({ count: 0, isError: false, isPaused: true, isPending: false }),
  "offline",
  "paused + settled + no data → offline, never empty",
);

assertEqual(
  archiveView({ count: 0, isError: true, isPaused: true, isPending: false }),
  "offline",
  "paused + error + no data → offline, never error",
);

assertEqual(
  archiveView({ count: 3, isError: false, isPaused: true, isPending: true }),
  "list",
  "data present while paused offline → still list",
);

const BANNED_IDENTITY_WORDS = [
  "transmission",
  "signal",
  "anomaly",
  "curated",
  "curation",
  "content",
  "stream",
  "mint",
];
assertEqual(
  archiveCopy.offline,
  "You're off the map for a minute. I'll pull the findings through the moment you're back.",
  "the offline line is the canon-reviewed string",
);
assertTrue(!archiveCopy.offline.includes("!"), "no exclamation marks in the offline line");

assertTrue(!archiveCopy.offline.toLowerCase().includes("range"), "no radio-coverage framing");
assertTrue(!archiveCopy.offline.includes("—"), "no em-dashes in the offline line");
for (const word of BANNED_IDENTITY_WORDS) {
  assertTrue(
    !archiveCopy.offline.toLowerCase().includes(word),
    `no retired identity word "${word}" in the offline line`,
  );
}

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

const full = findingMetaSegments({ bpm: 174.4, galaxyName: "Solar", key: "5A" });
assertEqual(full.length, 3, "bpm + key + galaxy → three segments");
assertEqual(full[0]?.text, "174 BPM", "bpm rounds and carries its unit");
assertEqual(full[0]?.numeric, true, "bpm is a figure → numeric");
assertEqual(full[1]?.text, "5A", "key passes through");
assertEqual(full[1]?.numeric, true, "key is a figure → numeric");
assertEqual(full[2]?.text, "Solar", "galaxy name passes through");
assertEqual(full[2]?.numeric, false, "galaxy name is prose → not numeric");

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
