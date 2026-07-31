// Self-running checks for the replica's schedule — no framework (see replica-identity.test.ts
// on the style). No timers and no AppState: the decisions are functions of a clock reading, so
// the whole truth table walks here rather than on a device.

import { REPLICA_SYNC_INTERVAL_MS, clearsDarkLatch, shouldSync } from "@/lib/replica-schedule";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const NOW = 1_800_000_000_000;

// 1. The first pull of a device's life always runs — that is the one moment the replica has
//    nothing at all to serve — and it runs whichever trigger fired it.
assertEqual(
  shouldSync({ inFlight: false, lastSyncedAt: undefined, now: NOW }),
  true,
  "never pulled",
);

// 2. Single flight. Two concurrent syncLibSQL() calls on one handle is the state the
//    file-keying rules exist to keep out, so an in-flight pull refuses everything.
assertEqual(
  shouldSync({ inFlight: true, lastSyncedAt: undefined, now: NOW }),
  false,
  "even the first pull waits its turn",
);
assertEqual(
  shouldSync({ inFlight: true, lastSyncedAt: NOW - REPLICA_SYNC_INTERVAL_MS * 10, now: NOW }),
  false,
  "a long-overdue pull still waits",
);

// 3. Freshness: inside the interval nothing pulls, at the boundary it does.
assertEqual(
  shouldSync({ inFlight: false, lastSyncedAt: NOW - 1, now: NOW }),
  false,
  "pulled a millisecond ago",
);
assertEqual(
  shouldSync({ inFlight: false, lastSyncedAt: NOW - REPLICA_SYNC_INTERVAL_MS + 1, now: NOW }),
  false,
  "one millisecond short of due",
);
assertEqual(
  shouldSync({ inFlight: false, lastSyncedAt: NOW - REPLICA_SYNC_INTERVAL_MS, now: NOW }),
  true,
  "due exactly at the interval",
);

// 4. A device clock that moved backwards reads as due rather than as fresh — trusting it could
//    strand the replica for hours.
assertEqual(
  shouldSync({ inFlight: false, lastSyncedAt: NOW + 60_000, now: NOW }),
  true,
  "a last-sync in the future is not freshness",
);

// 5. The interval is the modest in-session cadence the slice ruled, stated as a number a
//    reader can check rather than a computed one.
assertEqual(REPLICA_SYNC_INTERVAL_MS, 15 * 60 * 1000, "fifteen minutes");

// 6. Only a foreground transition lifts the dark latch, so an unwired deployment costs one
//    request per return to the app and none at all while it sits open.
assertEqual(clearsDarkLatch("foreground"), true, "coming back is worth one more ask");
assertEqual(clearsDarkLatch("bootstrap"), false, "a launch starts with the latch already open");
assertEqual(clearsDarkLatch("interval"), false, "the in-session timer never re-asks a dark one");

console.log("replica-schedule.test.ts: all assertions passed");
