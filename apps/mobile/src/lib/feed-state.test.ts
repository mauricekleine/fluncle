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
  resolveFeedState({ count: 0, isError: false, isPaused: false, isPending: true }),
  "loading",
  "pending + empty → loading",
);

// 2. The initial fetch failed with no data → error.
assertEqual(
  resolveFeedState({ count: 0, isError: true, isPaused: false, isPending: false }),
  "error",
  "error + empty → error",
);

// 3. The query resolved but the archive is empty → empty.
assertEqual(
  resolveFeedState({ count: 0, isError: false, isPaused: false, isPending: false }),
  "empty",
  "settled + empty → empty",
);

// 4. Any data in hand wins — a background refetch failing never blanks the feed, and
//    neither does losing the connection.
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

// 5. Offline. A parked query is `status: 'pending'` AND `fetchStatus: 'paused'` at the
//    same time, so "loading" must NOT be reachable here — that is the spinner that spins
//    forever in a tunnel.
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
// Precedence over a stale error: the retry control cannot work until a connection is
// back, so the honest answer is the connection, not "give it another go".
assertEqual(
  resolveFeedState({ count: 0, isError: true, isPaused: true, isPending: false }),
  "offline",
  "paused + error + empty → offline, never error",
);

// 6. The retry control is the ratified literal, not a voiced variant (Chrome Rule).
assertEqual(feedCopy.error.retry, "Try again", "retry control label");

// 7. The offline state carries NO control: the query resumes itself the moment the device
//    is back, so a button here would only ever work once it was already unnecessary.
assertTrue(
  !("retry" in feedCopy.offline),
  "the offline state offers no retry control (it would be chrome that lies)",
);

// 8. The prose obeys the Dry Rule (no exclamation marks), carries no em-dashes, and
// names none of VOICE.md's retired identity words (the radio metaphor especially —
// "Lost the signal" shipped here once).
// Substrings, so "stream" covers "streaming" and "mint" covers "minted" — the
// Engine-Room Rule's word, the one that drifted onto three surfaces before it was
// caught, so it is pinned here too.
//
// The canonical list is BANNED_WORDS in apps/web/src/lib/server/voice-words.ts,
// read by the runtime voice gates and by the repo-wide static voice lint
// (apps/web/src/lib/server/voice-lint.test.ts), which now covers apps/mobile/src
// too. A mobile test cannot import across apps, and this list is deliberately
// WIDER than the canonical one — substring matching plus the Engine-Room Rule's
// "mint" — so it stays as the local backstop rather than being deleted. Keep it
// in step when a canon ratification changes voice-words.ts.
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
