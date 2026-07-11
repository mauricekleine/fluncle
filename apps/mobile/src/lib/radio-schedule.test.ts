// Self-running checks for the radio shared-clock math — no framework, mirroring the
// repo's node:assert style (see media.test.ts). Run via `bun test` (reports "0 pass"
// — there are no describe/it blocks — but throws and fails the process on any failed
// assertion) or `bun src/lib/radio-schedule.test.ts`.
//
// This is the load-bearing test the brief asks for: the join / offset / advance
// decision is the one piece of radio logic that must be correct off the React screen,
// and it is the mobile twin of the web core's radio-schedule.test.ts. Pin the seam
// (hold vs advance vs resync), the segment floor, and the NTP-lite skew so a
// synchronized surface can't silently desync on this platform.

import {
  BOUNDARY_COMMIT_MS,
  radioBoundaryDecision,
  radioSkewSample,
  SEGMENT_FLOOR_MS,
  SEGMENT_STALE_AFTER_MS,
  segmentMs,
  smoothSkew,
} from "@/lib/radio-schedule";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertClose(
  actual: number,
  expected: number,
  epsilon = 1e-9,
  message = "not close",
): void {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}: expected ~${expected}, got ${actual}`);
  }
}

// segmentMs: a real observation length passes through (rounded); a null / sub-floor /
// corrupt value clamps to the floor so the cumulative walk never sees a zero slot.
assertEqual(segmentMs(8200), 8200, "real observation length passes through");
assertEqual(segmentMs(8200.6), 8201, "observation length rounds");
assertEqual(segmentMs(undefined), SEGMENT_FLOOR_MS, "undefined clamps to the floor");
assertEqual(segmentMs(0), SEGMENT_FLOOR_MS, "zero clamps to the floor");
assertEqual(segmentMs(1500), SEGMENT_FLOOR_MS, "a sub-floor sliver clamps to the floor");

// radioBoundaryDecision — the seam. Anchor a 10s segment at server-time 100_000.
const START = 100_000;
const DUR = 10_000;
const decide = (now: number) => radioBoundaryDecision(START, DUR, now);

assertEqual(decide(START + 4_000), "hold", "mid-segment holds");
assertEqual(decide(START), "hold", "the exact start holds");
// Just past the end but inside the commit band → still hold (no flip back).
assertEqual(decide(START + DUR + BOUNDARY_COMMIT_MS - 1), "hold", "within the commit band holds");
// Past the end by the commit margin → the normal scheduled advance.
assertEqual(decide(START + DUR + BOUNDARY_COMMIT_MS), "advance", "past commit advances");
assertEqual(decide(START + DUR + 2_000), "advance", "healthy overshoot advances");
// Wedged: past the end by the stale window with no advance → resync.
assertEqual(decide(START + DUR + SEGMENT_STALE_AFTER_MS), "resync", "a stale segment resyncs");
// A negative-skew overshoot before the segment even starts → resync, never advance.
assertEqual(decide(START - BOUNDARY_COMMIT_MS - 1), "resync", "before-start resyncs");
assertEqual(decide(START - 10), "hold", "a hair before start still holds");

// radioSkewSample — NTP-lite. Server epoch 1000 built at the response, RTT 200ms
// (sent 0, received 200): the one-way estimate is 1000 + 100 − 200 = 900ms ahead.
assertClose(radioSkewSample(1000, 0, 200), 900, 1e-9, "skew sample corrects for half RTT");
// A zero-RTT sample is exactly server − receive.
assertClose(radioSkewSample(5000, 4000, 4000), 1000, 1e-9, "zero-RTT skew is server − receive");

// smoothSkew — the first sample seeds; later ones ride the 0.7/0.3 EMA.
assertClose(smoothSkew(0, 900), 900, 1e-9, "first sample seeds the skew");
assertClose(smoothSkew(900, 1100), 900 * 0.7 + 1100 * 0.3, 1e-9, "later samples ride the EMA");
