// The arrival settle guard — pure envelope tests. Locks the shape the client rides:
// a floor on the first frame, unity once the window closes, monotone-eased between,
// and a smoothstep (zero slope at both ends — eased, never stepped).

import { describe, expect, test } from "bun:test";

import { SETTLE_FLOOR, SETTLE_MS, settleGain } from "./settle";

describe("settleGain — the arrival input-gain envelope", () => {
  test("starts at the floor on the first frame of an arrival", () => {
    expect(settleGain(0)).toBe(SETTLE_FLOOR);
    expect(settleGain(-100)).toBe(SETTLE_FLOOR); // never below the floor
  });

  test("reaches unity exactly at the window end and stays there", () => {
    expect(settleGain(SETTLE_MS)).toBe(1);
    expect(settleGain(SETTLE_MS + 5000)).toBe(1);
  });

  test("is monotone non-decreasing across the window (never overshoots 1)", () => {
    let prev = -1;
    for (let t = 0; t <= SETTLE_MS; t += 50) {
      const g = settleGain(t);
      expect(g).toBeGreaterThanOrEqual(prev);
      expect(g).toBeLessThanOrEqual(1);
      prev = g;
    }
  });

  test("is eased, not stepped: smoothstep has ~zero slope at both ends", () => {
    const dEnter = settleGain(1) - settleGain(0);
    const dExit = settleGain(SETTLE_MS) - settleGain(SETTLE_MS - 1);
    // A linear ramp would rise ~ (1-floor)/SETTLE_MS per ms at BOTH ends; smoothstep
    // is far flatter there. Guard the ease by requiring both endpoints to be gentle.
    const linearPerMs = (1 - SETTLE_FLOOR) / SETTLE_MS;
    expect(dEnter).toBeLessThan(linearPerMs);
    expect(dExit).toBeLessThan(linearPerMs);
  });

  test("passes the midpoint at the smoothstep midpoint (0.5 → floor + half the span)", () => {
    expect(settleGain(SETTLE_MS / 2)).toBeCloseTo(SETTLE_FLOOR + (1 - SETTLE_FLOOR) * 0.5, 6);
  });
});
