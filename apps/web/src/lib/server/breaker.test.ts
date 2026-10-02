import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeBreaker } from "./breaker";

describe("windowed breaker policy for Spotify reuse", () => {
  const breaker = makeBreaker({
    cooldownMs: 3_600_000,
    corruptTripped: true,
    failureWindowMs: 600_000,
    maxFailures: 5,
  });

  it("holds corrupt stamps closed while an absent or expired trip permits calls", () => {
    expect(breaker.verdict(1000, "invalid")).toEqual({
      cooldownRemainingMs: 3_600_000,
      corrupt: true,
      tripped: true,
    });
    expect(breaker.verdict(1000, null).tripped).toBe(false);
    expect(breaker.verdict(3_600_000, new Date(0).toISOString()).tripped).toBe(false);
  });

  it("trips on the fifth failure inside the rolling window and resets an expired streak", async () => {
    const snapshot = { failures: "4", lastFailureAt: new Date(0).toISOString() };
    expect(await Effect.runPromise(breaker.recordFailure(snapshot, 599_999))).toEqual({
      failures: "0",
      lastFailureAt: new Date(599_999).toISOString(),
      trippedAt: new Date(599_999).toISOString(),
    });
    expect(await Effect.runPromise(breaker.recordFailure(snapshot, 600_000))).toEqual({
      failures: "1",
      lastFailureAt: new Date(600_000).toISOString(),
    });
  });
});
