import { REPLICA_SYNC_INTERVAL_MS, clearsDarkLatch, shouldSync } from "@/lib/replica-schedule";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const NOW = 1_800_000_000_000;

assertEqual(
  shouldSync({ inFlight: false, lastSyncedAt: undefined, now: NOW }),
  true,
  "never pulled",
);

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

assertEqual(
  shouldSync({ inFlight: false, lastSyncedAt: NOW + 60_000, now: NOW }),
  true,
  "a last-sync in the future is not freshness",
);

assertEqual(REPLICA_SYNC_INTERVAL_MS, 15 * 60 * 1000, "fifteen minutes");

assertEqual(clearsDarkLatch("foreground"), true, "coming back is worth one more ask");
assertEqual(clearsDarkLatch("bootstrap"), false, "a launch starts with the latch already open");
assertEqual(clearsDarkLatch("interval"), false, "the in-session timer never re-asks a dark one");

console.log("replica-schedule.test.ts: all assertions passed");
