import { describe, expect, test } from "bun:test";

import { evaluatePaletteGate, PALETTE_MIN } from "./judge-palette";

function hist(bin: number, size = 8): Float32Array {
  const h = new Float32Array(size);
  h[bin] = 1;
  return h;
}

function blend(binA: number, binB: number, wA: number, size = 8): Float32Array {
  const h = new Float32Array(size);
  h[binA] = wA;
  h[binB] = 1 - wA;
  return h;
}

describe("evaluatePaletteGate", () => {
  test("skips (pass) when there is no neighbour", () => {
    const gate = evaluatePaletteGate("subject", hist(0), []);
    expect(gate.status).toBe("skipped");
    expect(gate.pass).toBe(true);
  });

  test("FAILS on a near-identical palette to any neighbour", () => {
    const gate = evaluatePaletteGate("subject", hist(0), [
      { hist: hist(3), logId: "n0" },
      { hist: hist(0), logId: "n1" },
      { hist: hist(5), logId: "n2" },
    ]);
    expect(gate.status).toBe("fail");
    expect(gate.pass).toBe(false);
    expect(gate.nearestDistance).toBeCloseTo(0);
    expect(gate.nearestAt).toBe(1);
  });

  test("passes when distinct from all neighbours", () => {
    const gate = evaluatePaletteGate("subject", hist(0), [
      { hist: hist(3), logId: "n0" },
      { hist: hist(5), logId: "n1" },
      { hist: hist(7), logId: "n2" },
    ]);
    expect(gate.status).toBe("pass");
    expect(gate.pass).toBe(true);

    expect(gate.nearestDistance).toBeCloseTo(1);
  });

  test("the nearest (most-similar) neighbour decides the verdict", () => {
    const gate = evaluatePaletteGate("subject", hist(0), [
      { hist: hist(4), logId: "n0" },
      { hist: blend(0, 4, 0.9), logId: "n1" },
    ]);
    expect(gate.nearestAt).toBe(1);
    expect(gate.nearestDistance).toBeLessThan(gate.neighbours[0].distance);
  });

  test("respects a custom threshold", () => {
    const neighbours = [{ hist: blend(0, 1, 0.85), logId: "n0" }];
    const lenient = evaluatePaletteGate("s", hist(0), neighbours, 0.05);
    const strict = evaluatePaletteGate("s", hist(0), neighbours, 0.95);
    expect(lenient.pass).toBe(true);
    expect(strict.pass).toBe(false);
  });

  test("the default floor is the calibrated PALETTE_MIN", () => {
    const gate = evaluatePaletteGate("s", hist(0), [{ hist: hist(1), logId: "n0" }]);
    expect(gate.threshold).toBe(PALETTE_MIN);
  });
});
