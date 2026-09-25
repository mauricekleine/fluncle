import { describe, expect, it } from "vitest";
import { SONIC_SCAN_TIMEOUT_MS } from "./search";
import { raceWithDeadline } from "./vector-fallback";

describe("raceWithDeadline — the sonic scan's abort ceiling", () => {
  it("resolves with the work when it wins the race", async () => {
    await expect(raceWithDeadline(Promise.resolve("done"), 1_000, "x")).resolves.toBe("done");
  });

  it("rejects once the timeout elapses on work that never settles", async () => {
    const never = new Promise<never>(() => {});

    await expect(raceWithDeadline(never, 10, "sonic vector scan")).rejects.toThrow(
      /sonic vector scan timed out after 10ms/,
    );
  });

  it("bounds the sonic scan with a positive ceiling above the measured prod latency", () => {
    expect(SONIC_SCAN_TIMEOUT_MS).toBeGreaterThan(8_070);
  });
});
