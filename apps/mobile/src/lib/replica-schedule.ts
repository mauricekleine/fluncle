// WHEN the replica pulls. Pure (no AppState, no timers, no RN tree) so the whole schedule is
// a truth table a test can walk, rather than behaviour that only shows up on a device.
//
// THE COLD-OPEN RULE: nothing here may run before the app is interactive. The first pull is
// ~23 MB against a live Turso database, and putting that anywhere near first paint would
// trade the app's fastest property for its newest one. So the bootstrap is fired AFTER the
// interactions settle, and every pull after it rides a moment the reader is not waiting on:
// an AppState foreground transition, or a modest in-session interval.
//
// Turso sync is manual in every stack by design — there is no auto-sync knob on
// expo-sqlite's handle — so this module IS the policy. Three triggers:
//
//   bootstrap  — the app became interactive. Pulls only if this device has never pulled, or
//                the interval has passed; a warm relaunch reads the file it already has.
//   foreground — the app came back. The reader is about to look at something, and this is
//                the moment a fresh cut is worth most. It is also the ONLY trigger that
//                lifts the dark latch (see `clearsDarkLatch`).
//   interval   — the app has been open a while. A quiet top-up, never a poll: at fifteen
//                minutes it costs one no-op pull an hour of use.
//
// The freshness gate is the same for all three, and the single-flight guard is not an
// optimisation — two concurrent `syncLibSQL()` calls on one handle is precisely the state
// the file-keying rules exist to keep out.

/** How long a pulled cut is treated as fresh enough. */
export const REPLICA_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** Why a pull is being considered. */
export type SyncTrigger = "bootstrap" | "foreground" | "interval";

export type SyncDecisionInput = {
  /** True while a pull is already running — the single-flight guard. */
  inFlight: boolean;
  /** When the last pull COMPLETED, or undefined if this device has never pulled. */
  lastSyncedAt: number | undefined;
  now: number;
};

/**
 * Should a pull run now?
 *
 * Never while one is in flight. Always on the first pull of a device's life — that is the one
 * moment the replica has nothing at all to serve. After that, only once the interval has
 * passed.
 *
 * A `lastSyncedAt` in the future (the device clock moved backwards) reads as due rather than
 * as fresh: trusting it would strand the replica until the clock caught up, which could be
 * hours.
 */
export function shouldSync({ inFlight, lastSyncedAt, now }: SyncDecisionInput): boolean {
  if (inFlight) {
    return false;
  }
  if (lastSyncedAt === undefined) {
    return true;
  }
  if (now < lastSyncedAt) {
    return true;
  }
  return now - lastSyncedAt >= REPLICA_SYNC_INTERVAL_MS;
}

/**
 * Does this trigger lift the dark latch?
 *
 * A `replica_unavailable` answer means the endpoint is unwired, which no amount of retrying
 * changes — so the latch drops and the in-session interval stops asking. Only a foreground
 * transition (or the next launch, which starts with the latch open) tries again: a deployment
 * that gets wired while the app sits in the background is then picked up the moment the
 * reader comes back, without a single wasted request in between.
 */
export function clearsDarkLatch(trigger: SyncTrigger): boolean {
  return trigger === "foreground";
}
