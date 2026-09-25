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

assertEqual(segmentMs(8200), 8200, "real observation length passes through");
assertEqual(segmentMs(8200.6), 8201, "observation length rounds");
assertEqual(segmentMs(undefined), SEGMENT_FLOOR_MS, "undefined clamps to the floor");
assertEqual(segmentMs(0), SEGMENT_FLOOR_MS, "zero clamps to the floor");
assertEqual(segmentMs(1500), SEGMENT_FLOOR_MS, "a sub-floor sliver clamps to the floor");

const START = 100_000;
const DUR = 10_000;
const decide = (now: number) => radioBoundaryDecision(START, DUR, now);

assertEqual(decide(START + 4_000), "hold", "mid-segment holds");
assertEqual(decide(START), "hold", "the exact start holds");

assertEqual(decide(START + DUR + BOUNDARY_COMMIT_MS - 1), "hold", "within the commit band holds");

assertEqual(decide(START + DUR + BOUNDARY_COMMIT_MS), "advance", "past commit advances");
assertEqual(decide(START + DUR + 2_000), "advance", "healthy overshoot advances");

assertEqual(decide(START + DUR + SEGMENT_STALE_AFTER_MS), "resync", "a stale segment resyncs");

assertEqual(decide(START - BOUNDARY_COMMIT_MS - 1), "resync", "before-start resyncs");
assertEqual(decide(START - 10), "hold", "a hair before start still holds");

assertClose(radioSkewSample(1000, 0, 200), 900, 1e-9, "skew sample corrects for half RTT");

assertClose(radioSkewSample(5000, 4000, 4000), 1000, 1e-9, "zero-RTT skew is server − receive");

assertClose(smoothSkew(0, 900), 900, 1e-9, "first sample seeds the skew");
assertClose(smoothSkew(900, 1100), 900 * 0.7 + 1100 * 0.3, 1e-9, "later samples ride the EMA");
