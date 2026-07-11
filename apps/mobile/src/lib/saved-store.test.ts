// Self-running checks for the device-local saved-findings logic — no framework,
// mirroring the repo's node:assert-free style (submit-fault.test.ts). Run via
// `bun test` (reports "0 pass" — no describe/it blocks — but throws and fails the
// process on any failed assertion) or `bun src/lib/saved-store.test.ts`.
//
// These pin the toggle idempotence, the newest-first order, keying by coordinate,
// and the tolerant deserialize (garbage in storage must never crash the app or
// resurrect a partial row).

import {
  type SavableFinding,
  type SavedFinding,
  addSaved,
  deserialize,
  isSaved,
  removeSaved,
  savedKey,
  serialize,
  toggleSaved,
} from "@/lib/saved-store";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const finding = (logId: string, trackId = `t-${logId}`): SavableFinding => ({
  artists: ["Netsky"],
  logId,
  title: `Track ${logId}`,
  trackId,
});

// 1. The key is the coordinate, falling back to the trackId.
assertEqual(savedKey({ logId: "024.7.2R", trackId: "abc" }), "024.7.2R", "logId is the key");
assertEqual(savedKey({ trackId: "abc" }), "abc", "no logId → trackId is the key");

// 2. Toggle adds when absent, removes when present (idempotent flip).
let list: SavedFinding[] = [];
list = toggleSaved(list, finding("A"), 1000);
assertEqual(list.length, 1, "first toggle saves");
assertEqual(isSaved(list, finding("A")), true, "now saved");
list = toggleSaved(list, finding("A"), 2000);
assertEqual(list.length, 0, "second toggle unsaves");
assertEqual(isSaved(list, finding("A")), false, "now unsaved");

// 3. addSaved is idempotent; newest lands at the front.
list = addSaved([], finding("A"), 1000);
list = addSaved(list, finding("B"), 2000);
assertEqual(list[0]?.logId, "B", "newest save leads");
const same = addSaved(list, finding("A"), 3000);
assertEqual(same.length, 2, "re-adding an already-saved finding is a no-op");
assertEqual(same[0]?.logId, "B", "no-op re-add doesn't reorder");

// 4. removeSaved drops by key, leaves the rest.
const pruned = removeSaved(list, finding("A"));
assertEqual(pruned.length, 1, "remove drops one");
assertEqual(pruned[0]?.logId, "B", "the other survives");

// 5. Round-trip serialize → deserialize preserves rows, newest-first.
const roundTrip = deserialize(serialize(list));
assertEqual(roundTrip.length, 2, "both rows survive the round trip");
assertEqual(roundTrip[0]?.logId, "B", "deserialize sorts newest-first");
assertEqual(roundTrip[1]?.logId, "A", "older row follows");

// 6. Tolerant deserialize: null, garbage, wrong version, partial rows → empty/dropped.
assertEqual(deserialize(null).length, 0, "null → empty");
assertEqual(deserialize(undefined).length, 0, "undefined → empty");
assertEqual(deserialize("not json {{{").length, 0, "invalid JSON → empty");
assertEqual(
  deserialize(JSON.stringify({ items: [], version: 99 })).length,
  0,
  "wrong version → empty",
);
assertEqual(
  deserialize(JSON.stringify({ items: [{ logId: "X" }], version: 1 })).length,
  0,
  "a row missing required fields is dropped (no title/artists/savedAt)",
);
assertEqual(
  deserialize(JSON.stringify({ items: "nope", version: 1 })).length,
  0,
  "non-array items → empty",
);
