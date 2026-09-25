import { feedCopy, resolveFeedState } from "@/lib/feed-state";

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
  resolveFeedState({ count: 0, isError: false, isPaused: false, isPending: true }),
  "loading",
  "pending + empty → loading",
);

assertEqual(
  resolveFeedState({ count: 0, isError: true, isPaused: false, isPending: false }),
  "error",
  "error + empty → error",
);

assertEqual(
  resolveFeedState({ count: 0, isError: false, isPaused: false, isPending: false }),
  "empty",
  "settled + empty → empty",
);

assertEqual(
  resolveFeedState({ count: 3, isError: false, isPaused: false, isPending: false }),
  "ready",
  "has data → ready",
);
assertEqual(
  resolveFeedState({ count: 3, isError: true, isPaused: false, isPending: false }),
  "ready",
  "has data even while erroring → ready",
);
assertEqual(
  resolveFeedState({ count: 3, isError: false, isPaused: true, isPending: true }),
  "ready",
  "has data even while paused offline → ready (the data-wins law holds)",
);

assertEqual(
  resolveFeedState({ count: 0, isError: false, isPaused: true, isPending: true }),
  "offline",
  "paused + pending + empty → offline, never loading",
);
assertEqual(
  resolveFeedState({ count: 0, isError: false, isPaused: true, isPending: false }),
  "offline",
  "paused + settled + empty → offline, never empty",
);

assertEqual(
  resolveFeedState({ count: 0, isError: true, isPaused: true, isPending: false }),
  "offline",
  "paused + error + empty → offline, never error",
);

assertEqual(feedCopy.error.retry, "Try again", "retry control label");

assertTrue(
  !("retry" in feedCopy.offline),
  "the offline state offers no retry control (it would be chrome that lies)",
);

assertEqual(feedCopy.offline.title, "Off the map", "the offline title is the reviewed string");
assertEqual(
  feedCopy.offline.body,
  "I can't reach the archive from here. Soon as you're back online, I'll pull the findings straight through.",
  "the offline body is the reviewed string",
);
for (const line of [feedCopy.offline.title, feedCopy.offline.body]) {
  assertTrue(!line.toLowerCase().includes("range"), `no radio-coverage framing: "${line}"`);

  assertTrue(
    !/\bfind a\b/i.test(line),
    `the found-family verb is not spent on a router: "${line}"`,
  );
}

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

const prose = [
  feedCopy.empty.title,
  feedCopy.empty.body,
  feedCopy.error.title,
  feedCopy.error.body,
  feedCopy.footer,
  feedCopy.loading,
  feedCopy.offline.title,
  feedCopy.offline.body,
];
for (const line of prose) {
  assertTrue(!line.includes("!"), `no exclamation marks in prose: "${line}"`);
  assertTrue(!line.includes("—"), `no em-dashes in prose: "${line}"`);

  for (const word of BANNED_IDENTITY_WORDS) {
    assertTrue(
      !line.toLowerCase().includes(word),
      `no retired identity word "${word}" in prose: "${line}"`,
    );
  }
}
