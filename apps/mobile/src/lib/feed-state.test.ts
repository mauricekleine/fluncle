// Self-running checks for the feed's view-state resolver + its copy — no framework,
// mirroring submit-fault.test.ts's node:assert-free style (the Expo tsconfig has no
// @types/node). Run via `bun test` (reports "0 pass" — no describe/it blocks — but
// throws and fails the process on any failed assertion) or `bun src/lib/feed-state.test.ts`.
//
// Pins the four honest states the Stories screen must render (loading / error / empty /
// ready) and the voice rails on their copy: the retry control is a plain literal (the
// Chrome Rule), and the prose carries no exclamation marks (the Dry Rule) or em-dashes.

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

// 1. First paint, nothing fetched yet → loading.
assertEqual(
  resolveFeedState({ count: 0, isError: false, isPending: true }),
  "loading",
  "pending + empty → loading",
);

// 2. The initial fetch failed with no data → error.
assertEqual(
  resolveFeedState({ count: 0, isError: true, isPending: false }),
  "error",
  "error + empty → error",
);

// 3. The query resolved but the archive is empty → empty.
assertEqual(
  resolveFeedState({ count: 0, isError: false, isPending: false }),
  "empty",
  "settled + empty → empty",
);

// 4. Any data in hand wins — a background refetch failing never blanks the feed.
assertEqual(
  resolveFeedState({ count: 3, isError: false, isPending: false }),
  "ready",
  "has data → ready",
);
assertEqual(
  resolveFeedState({ count: 3, isError: true, isPending: false }),
  "ready",
  "has data even while erroring → ready",
);

// 5. The retry control is the ratified literal, not a voiced variant (Chrome Rule).
assertEqual(feedCopy.error.retry, "Try again", "retry control label");

// 6. The prose obeys the Dry Rule (no exclamation marks) and carries no em-dashes.
const prose = [
  feedCopy.empty.title,
  feedCopy.empty.body,
  feedCopy.error.title,
  feedCopy.error.body,
  feedCopy.footer,
  feedCopy.loading,
];
for (const line of prose) {
  assertTrue(!line.includes("!"), `no exclamation marks in prose: "${line}"`);
  assertTrue(!line.includes("—"), `no em-dashes in prose: "${line}"`);
}
