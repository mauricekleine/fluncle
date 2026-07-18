import { describe, expect, it } from "vitest";
import { raceWithTimeout, SONIC_SCAN_TIMEOUT_MS } from "./search";

// The sonic vector scan (runSonic) had NO abort bound — it ran 8.07s on prod and grows with the
// catalogue, on a surface (/mcp) with no session to lean on. `raceWithTimeout` is the ceiling that
// stops the caller (and the Worker request) waiting past a fixed bound. libSQL's `execute` cannot
// be cancelled, so what the timeout does is stop WAITING — proven here on the pure helper (the
// happy path through the wrapper is proven end-to-end by search.integration.test.ts's sonic case).

describe("raceWithTimeout — the sonic scan's abort ceiling", () => {
  it("resolves with the work when it wins the race", async () => {
    await expect(raceWithTimeout(Promise.resolve("done"), 1_000, "x")).resolves.toBe("done");
  });

  it("rejects once the timeout elapses on work that never settles", async () => {
    const never = new Promise<never>(() => {
      // intentionally never resolves — the timeout must win
    });

    await expect(raceWithTimeout(never, 10, "sonic vector scan")).rejects.toThrow(
      /sonic vector scan timed out after 10ms/,
    );
  });

  it("bounds the sonic scan with a positive ceiling above the measured prod latency", () => {
    // 8.07s measured on prod; the ceiling sits above it with headroom, so it never trips a
    // legitimate query today while still capping a growing catalogue.
    expect(SONIC_SCAN_TIMEOUT_MS).toBeGreaterThan(8_070);
  });
});
