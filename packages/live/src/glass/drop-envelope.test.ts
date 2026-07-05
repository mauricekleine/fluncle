// The drop-reveal envelope engine tests — the pure math that owns the reveal. Covers the
// arc shape (buried -> crest -> settle), retrigger, the reveal punch, the max() fold with
// the living idle, and the detector's hysteresis over synthetic energy traces.

import { describe, expect, test } from "bun:test";

import {
  ARC_CREST_FRACTION,
  ARC_SPAN_MS,
  CANONICAL_ARC_SHAPE,
  clamp01,
  DEFAULT_DROP_DETECTOR,
  DropDetector,
  DropEnvelope,
  dropPulse,
  REVEAL_SHAPE,
  smoothstep,
} from "./drop-envelope.ts";

describe("smoothstep — matches the offline hook", () => {
  test("clamps below edge0 and above edge1", () => {
    expect(smoothstep(1, 2, 0)).toBe(0);
    expect(smoothstep(1, 2, 3)).toBe(1);
  });
  test("is 0.5 at the midpoint and eased (never linear)", () => {
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(0, 1, 0.25)).toBeLessThan(0.25); // eased-in
  });
  test("degenerate edge0 === edge1 is a hard step", () => {
    expect(smoothstep(5, 5, 4.99)).toBe(0);
    expect(smoothstep(5, 5, 5)).toBe(1);
  });
});

describe("dropPulse — a rise/hold/fall pulse around a peak", () => {
  const shape = { fallMs: 2000, holdMs: 500, riseMs: 1000 };
  const peak = 10000;

  test("is 0 before the rise begins and after the fall completes", () => {
    expect(dropPulse(peak - shape.riseMs - 1, peak, shape)).toBe(0);
    expect(dropPulse(peak + shape.holdMs + shape.fallMs + 1, peak, shape)).toBe(0);
  });
  test("reaches the crest (~1) at the peak and through the hold", () => {
    expect(dropPulse(peak, peak, shape)).toBeCloseTo(1, 6);
    expect(dropPulse(peak + shape.holdMs, peak, shape)).toBeCloseTo(1, 6);
  });
  test("rises monotonically into the peak", () => {
    let prev = -1;
    for (let t = peak - shape.riseMs; t <= peak; t += 100) {
      const v = dropPulse(t, peak, shape);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  test("falls monotonically after the hold", () => {
    let prev = 2;
    for (let t = peak + shape.holdMs; t <= peak + shape.holdMs + shape.fallMs; t += 100) {
      const v = dropPulse(t, peak, shape);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("DropEnvelope — the scripted arrival arc (prong 1)", () => {
  test("an un-triggered engine is exactly its living idle (abstract-era scenes unchanged)", () => {
    const e = new DropEnvelope();
    for (const idle of [0, 0.2, 0.5, 1]) {
      expect(e.value(1000, idle)).toBeCloseTo(clamp01(idle), 6);
    }
    expect(e.arcActive).toBe(false);
  });

  test("buried -> crest -> settle: low early, ~1 at the crest, back to idle after", () => {
    const e = new DropEnvelope();
    const t0 = 5000;
    e.triggerArc(t0); // canonical span, no live audio (idle 0)
    const crestMs = t0 + ARC_SPAN_MS * ARC_CREST_FRACTION;

    // buried: right after arrival the arc has not risen yet.
    expect(e.value(t0 + 200, 0)).toBeLessThan(0.15);
    // crest: the peak SHOWS.
    expect(e.value(crestMs, 0)).toBeGreaterThan(0.95);
    // settle: after hold + fall the world is back to its living idle.
    const endMs = crestMs + CANONICAL_ARC_SHAPE.holdMs + CANONICAL_ARC_SHAPE.fallMs;
    expect(e.value(endMs + 100, 0)).toBeCloseTo(0, 6);
    expect(e.arcActive).toBe(false); // retired
  });

  test("a scene's archived shape overrides the canonical surge/settle", () => {
    const e = new DropEnvelope();
    const t0 = 0;
    const shape = { fallMs: 1700, holdMs: 3600, riseMs: 1100 }; // eventide-beacon (033.0.1O)
    e.triggerArc(t0, 240000, shape); // long track -> span caps at ARC_SPAN_MS
    const crestMs = t0 + ARC_SPAN_MS * ARC_CREST_FRACTION;
    expect(e.value(crestMs, 0)).toBeGreaterThan(0.95);
    // the tight archived pulse has fully fallen well before the canonical fall would:
    const archivedEnd = crestMs + shape.holdMs + shape.fallMs;
    expect(e.value(archivedEnd + 100, 0)).toBeCloseTo(0, 6);
  });

  test("re-trigger restarts the arc so the peak shows again (replay `v`)", () => {
    const e = new DropEnvelope();
    e.triggerArc(0);
    const firstCrest = ARC_SPAN_MS * ARC_CREST_FRACTION;
    // let the first arc fully settle
    const firstEnd = firstCrest + CANONICAL_ARC_SHAPE.holdMs + CANONICAL_ARC_SHAPE.fallMs;
    expect(e.value(firstEnd + 100, 0)).toBeCloseTo(0, 6);
    // replay: a fresh arc from a new t0 crests again
    const t1 = firstEnd + 1000;
    e.triggerArc(t1);
    const secondCrest = t1 + ARC_SPAN_MS * ARC_CREST_FRACTION;
    expect(e.value(secondCrest, 0)).toBeGreaterThan(0.95);
  });

  test("the living idle still shows through under a buried arc (max fold)", () => {
    const e = new DropEnvelope();
    e.triggerArc(0);
    // during the buried phase, a real live idle of 0.4 is not suppressed
    expect(e.value(200, 0.4)).toBeCloseTo(0.4, 6);
  });

  test("clearArc drops the arc back to the living idle", () => {
    const e = new DropEnvelope();
    e.triggerArc(0);
    e.clearArc();
    expect(e.arcActive).toBe(false);
    expect(e.value(ARC_SPAN_MS * ARC_CREST_FRACTION, 0.1)).toBeCloseTo(0.1, 6);
  });
});

describe("DropEnvelope — the live reveal punch (prong 2)", () => {
  test("fast attack, hold, ~8s release back to the idle — never a snap", () => {
    const e = new DropEnvelope();
    const t0 = 1000;
    e.fireReveal(t0);
    expect(e.revealActive).toBe(true);
    // buried at fire, crest one attack later
    expect(e.value(t0, 0)).toBeLessThan(0.1);
    expect(e.value(t0 + REVEAL_SHAPE.riseMs, 0)).toBeGreaterThan(0.95);
    // mid-release it is still easing down (not snapped to 0)
    const mid = t0 + REVEAL_SHAPE.riseMs + REVEAL_SHAPE.holdMs + REVEAL_SHAPE.fallMs / 2;
    const v = e.value(mid, 0);
    expect(v).toBeGreaterThan(0.1);
    expect(v).toBeLessThan(0.95);
    // fully released -> idle
    const end = t0 + REVEAL_SHAPE.riseMs + REVEAL_SHAPE.holdMs + REVEAL_SHAPE.fallMs;
    expect(e.value(end + 100, 0)).toBeCloseTo(0, 6);
    expect(e.revealActive).toBe(false);
  });

  test("arc and reveal coexist: whichever is louder wins (max)", () => {
    const e = new DropEnvelope();
    e.triggerArc(0);
    // fire a reveal during the arc's buried phase; the reveal crest shows over the buried arc
    e.fireReveal(500);
    expect(e.value(500 + REVEAL_SHAPE.riseMs, 0)).toBeGreaterThan(0.95);
  });
});

// ── the drop DETECTOR ────────────────────────────────────────────────────────
/** Feed a synthetic energy trace at 60fps; return the fire times (ms). */
function runTrace(det: DropDetector, energyAt: (ms: number) => number, totalMs: number): number[] {
  const fires: number[] = [];
  for (let t = 0; t <= totalMs; t += 16) {
    if (det.observe(t, energyAt(t))) {
      fires.push(t);
    }
  }
  return fires;
}

describe("DropDetector — the DnB drop signature (dip -> slam)", () => {
  test("fires once on a clean breakdown -> slam", () => {
    const det = new DropDetector();
    // loud 0..2s, breakdown (dip) 2..5s, slam 5..12s
    const fires = runTrace(det, (ms) => (ms < 2000 ? 0.6 : ms < 5000 ? 0.08 : 0.85), 12000);
    expect(fires.length).toBe(1);
    // fires shortly after the slam begins (confirm dwell), not before
    expect(fires[0]).toBeGreaterThanOrEqual(5000 + DEFAULT_DROP_DETECTOR.confirmMs);
    expect(fires[0]).toBeLessThan(5000 + DEFAULT_DROP_DETECTOR.confirmMs + 100);
  });

  test("never fires on a steady loud section (never armed — no dip)", () => {
    const det = new DropDetector();
    expect(runTrace(det, () => 0.65, 15000)).toEqual([]);
    expect(det.isArmed).toBe(false);
  });

  test("never fires on a dip that never slams (energy returns only to the mid band)", () => {
    const det = new DropDetector();
    // dip 0..3s then recovers only to 0.45 (below surgeLevel 0.55)
    const fires = runTrace(det, (ms) => (ms < 3000 ? 0.1 : 0.45), 12000);
    expect(fires).toEqual([]);
    expect(det.isArmed).toBe(true); // armed by the dip, but the slam never qualified
  });

  test("hysteresis: jitter inside the dip..surge band neither arms nor fires", () => {
    const det = new DropDetector();
    // oscillate 0.35..0.5 — never below dipLevel 0.28, never above surgeLevel 0.55
    const fires = runTrace(det, (ms) => 0.42 + 0.08 * Math.sin(ms / 100), 15000);
    expect(fires).toEqual([]);
    expect(det.isArmed).toBe(false);
  });

  test("a brief slam under the confirm dwell does not fire", () => {
    const det = new DropDetector();
    // dip 0..3s, a 150ms blip of loud at 5s (< confirmMs 250), then quiet
    const fires = runTrace(
      det,
      (ms) => (ms < 3000 ? 0.1 : ms >= 5000 && ms < 5150 ? 0.8 : 0.2),
      9000,
    );
    expect(fires).toEqual([]);
  });

  test("refractory: two drops inside the window fire once; a later one fires again", () => {
    const det = new DropDetector();
    // drop A: dip 0..2s, slam 2..4s; drop B (inside refractory): dip 4..5s, slam 5..7s;
    // drop C (past refractory): dip 14..16s, slam 16..20s
    const energyAt = (ms: number): number => {
      if (ms < 2000) {
        return 0.08;
      }
      if (ms < 4000) {
        return 0.85;
      }
      if (ms < 5000) {
        return 0.08;
      }
      if (ms < 7000) {
        return 0.85;
      }
      if (ms < 16000) {
        return 0.08;
      }
      return 0.85;
    };
    const fires = runTrace(det, energyAt, 21000);
    expect(fires.length).toBe(2);
    // the second fire is at least a refractory window after the first
    expect(fires[1] - fires[0]).toBeGreaterThanOrEqual(DEFAULT_DROP_DETECTOR.refractoryMs);
  });

  test("reset clears armed + refractory state", () => {
    const det = new DropDetector();
    runTrace(det, (ms) => (ms < 3000 ? 0.1 : 0.85), 6000);
    det.reset();
    expect(det.isArmed).toBe(false);
  });
});
