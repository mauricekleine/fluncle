// Pure matcher math — mel-frame cosine, the best-offset score, the sustain/dwell
// advance logic, manual override, and the energy pre-arm detector. No network, no
// ffmpeg (the fixture-based accuracy run lives in accuracy.ts, excluded from
// `bun test`). Deterministic synthetic fingerprints stand in for real previews.

import { describe, expect, test } from "bun:test";

import { MEL_BINS } from "../contract";
import {
  bestOffsetScore,
  budgetedOffsetStep,
  DEFAULT_MATCHER_CONFIG,
  EnergyPrearm,
  type Fingerprint,
  frameCosine,
  OFFSET_POSITION_BUDGET,
  PlanMatcher,
} from "./matcher";
import { shapeNormalize } from "./mel";

/** A deterministic SHAPE-normalized frame from a seed: a spectral bump whose
 * position is seed-keyed, so distinct seeds are near-orthogonal after
 * mean-subtraction (mirroring how real distinct tracks separate in this domain). */
function frame(seed: number, jitter = 0): Float32Array {
  const v = new Float32Array(MEL_BINS);
  const center = (seed * 7) % MEL_BINS;
  for (let i = 0; i < MEL_BINS; i++) {
    const d = Math.min(Math.abs(i - center), MEL_BINS - Math.abs(i - center));
    v[i] = Math.exp(-(d * d) / 8) + jitter * Math.sin(i * 2.1 + seed);
  }
  return shapeNormalize(v);
}

/** A run of frames all sharing one seed = one track's stable "sound". */
function track(seed: number, count: number, jitter = 0): Float32Array[] {
  return Array.from({ length: count }, () => frame(seed, jitter));
}

describe("frameCosine", () => {
  test("identical normalized frames score ~1", () => {
    const a = frame(3);
    expect(frameCosine(a, a)).toBeCloseTo(1, 5);
  });

  test("different shapes score below 1", () => {
    expect(frameCosine(frame(1), frame(50))).toBeLessThan(0.99);
  });
});

describe("bestOffsetScore", () => {
  test("a window that IS a slice of the preview scores ~1 at the best offset", () => {
    const fp = track(7, 300);
    const window = fp.slice(120, 220); // a 100-frame slice
    expect(bestOffsetScore(window, fp, 1)).toBeCloseTo(1, 4);
  });

  test("a foreign window scores below a matching one", () => {
    const fp = track(7, 300);
    const matching = track(7, 100);
    const foreign = track(40, 100);
    expect(bestOffsetScore(matching, fp, 3)).toBeGreaterThan(bestOffsetScore(foreign, fp, 3));
  });

  test("empty inputs score 0", () => {
    expect(bestOffsetScore([], track(1, 10), 1)).toBe(0);
    expect(bestOffsetScore(track(1, 10), [], 1)).toBe(0);
  });

  test("is symmetric in length (window longer than preview)", () => {
    const longWindow = track(9, 300);
    const shortFp = longWindow.slice(50, 130);
    expect(bestOffsetScore(longWindow, shortFp, 1)).toBeCloseTo(1, 4);
  });
});

describe("budgetedOffsetStep", () => {
  // window ~22s (220 frames @10Hz), preview ~30s (299), full song ~5min (2999).
  const WINDOW = 220;

  test("keeps the floor step for a short (preview-length) reference", () => {
    // span 79 « budget, so no coarsening — a preview keeps its 300ms (step 3) resolution.
    expect(budgetedOffsetStep(WINDOW, 299, 3)).toBe(3);
  });

  test("coarsens a full-song reference so sliding positions stay within the budget", () => {
    const step = budgetedOffsetStep(WINDOW, 2999, 3);
    expect(step).toBeGreaterThan(3); // a full song must coarsen past the floor
    const positions = Math.floor((2999 - WINDOW) / step) + 1;
    expect(positions).toBeLessThanOrEqual(OFFSET_POSITION_BUDGET + 1);
  });

  test("never returns below 1, even for a degenerate/zero span", () => {
    expect(budgetedOffsetStep(300, 300, 0)).toBeGreaterThanOrEqual(1);
    expect(budgetedOffsetStep(400, 300, 3)).toBe(3); // span ≤ 0 → the floor
  });
});

describe("EnergyPrearm", () => {
  test("fires on a held dip followed by a surge, not on steady energy", () => {
    const pre = new EnergyPrearm();
    let fired = false;
    // 30s of steady mid energy — establishes the swell baseline, no fire.
    for (let t = 0; t < 30_000; t += 100) {
      fired = pre.push(0.5, t) || fired;
    }
    expect(fired).toBe(false);
    // A ~3s dip (breakdown).
    for (let t = 30_000; t < 33_000; t += 100) {
      pre.push(0.05, t);
    }
    // The surge (slam) — should fire once within the first surging frames.
    let surged = false;
    for (let t = 33_000; t < 34_000; t += 100) {
      surged = pre.push(0.9, t) || surged;
    }
    expect(surged).toBe(true);
  });

  test("stays quiet below the silence floor", () => {
    const pre = new EnergyPrearm();
    let fired = false;
    for (let t = 0; t < 20_000; t += 100) {
      fired = pre.push(0.02, t) || fired;
    }
    expect(fired).toBe(false);
  });
});

describe("PlanMatcher", () => {
  const cfg = {
    ...DEFAULT_MATCHER_CONFIG,
    // shrink the timers so the unit test advances in a few virtual seconds
    firstDwellMs: 1_000,
    minDwellMs: 1_000,
    sustainMs: 1_500,
    windowFrames: 60,
  };

  function fps(seeds: (number | null)[]): Fingerprint[] {
    return seeds.map((s, i) => ({
      frames: s === null ? null : track(s, 300),
      logId: `T${i}`,
    }));
  }

  test("advances when the pending track's audio plays, in order", () => {
    const m = new PlanMatcher(fps([1, 2, 3]), cfg);
    // Play track 1's audio (pending after pointer 0). Feed > window + sustain frames.
    let t = 0;
    let advanced = false;
    for (let i = 0; i < 120; i++, t += 100) {
      const tick = m.pushFrame(frame(2), 0.5, t);
      advanced = advanced || tick.advanced;
    }
    expect(advanced).toBe(true);
    expect(m.pointerIndex).toBe(1);
    expect(m.pointerSource).toBe("fingerprint");
  });

  test("does NOT advance on foreign audio (no false positive)", () => {
    const m = new PlanMatcher(fps([1, 2, 3]), cfg);
    let t = 0;
    for (let i = 0; i < 200; i++, t += 100) {
      m.pushFrame(frame(5), 0.5, t); // a spectral bump far from every planned one
    }
    expect(m.pointerIndex).toBe(0);
  });

  test("emits NO spurious advance to a track whose audio never plays (no phantom/premature id)", () => {
    // The accuracy harness's `spurious` property, automated at the unit level: over a
    // LONG horizon (60s, many dwell+sustain windows) a window that is a slice of NONE
    // of the planned fingerprints must never make the matcher EMIT a pending id — not
    // via the single-advance gate and not via the double-advance skip path. seed 11's
    // spectral bump (mel bin ~37) is maximally far from every planned bump (bins
    // 7/14/21/28), so it scores ~0 against all of them. This is a real gate property,
    // NOT the tautological monotone ordering (which is true by construction).
    const m = new PlanMatcher(fps([1, 2, 3, 4]), cfg);
    const advancedIds: number[] = [];
    let t = 0;
    for (let i = 0; i < 600; i++, t += 100) {
      const tick = m.pushFrame(frame(11), 0.5, t);
      if (tick.advanced) {
        advancedIds.push(tick.pointer);
      }
    }
    expect(advancedIds).toEqual([]);
    expect(m.pointerIndex).toBe(0);
    expect(m.pointerSource).toBe("boot");
  });

  test("skip-ahead: a weak pending is skipped when pending+1 confirms strongly", () => {
    // Pointer 0; pending = 1; pending+1 = 2. Play track 2's audio: the pending
    // never matches, but pending+1 does — the pointer must advance TWO (monotone),
    // not park behind the weak preview.
    const m = new PlanMatcher(fps([1, 2, 3]), cfg);
    let t = 0;
    let advanced = false;
    for (let i = 0; i < 140; i++, t += 100) {
      const tick = m.pushFrame(frame(3), 0.5, t);
      advanced = advanced || tick.advanced;
    }
    expect(advanced).toBe(true);
    expect(m.pointerIndex).toBe(2);
    expect(m.pointerSource).toBe("fingerprint");
  });

  test("manual advance/rewind/goto always win instantly", () => {
    const m = new PlanMatcher(fps([1, 2, 3, 4]), cfg);
    m.advance(0);
    expect(m.pointerIndex).toBe(1);
    expect(m.pointerSource).toBe("manual");
    m.goto(3, 100);
    expect(m.pointerIndex).toBe(3);
    m.rewind(200);
    expect(m.pointerIndex).toBe(2);
    // clamped
    m.goto(99, 300);
    expect(m.pointerIndex).toBe(3);
    m.goto(-5, 400);
    expect(m.pointerIndex).toBe(0);
  });

  test("skips a preview-less pending (advances to the next fingerprintable)", () => {
    // track 1 has no preview; playing track 2's audio should jump the pointer to 2.
    const m = new PlanMatcher(fps([1, null, 3]), cfg);
    let t = 0;
    let advanced = false;
    for (let i = 0; i < 140; i++, t += 100) {
      const tick = m.pushFrame(frame(3), 0.5, t);
      advanced = advanced || tick.advanced;
    }
    expect(advanced).toBe(true);
    expect(m.pointerIndex).toBe(2);
  });

  test("respects the first-dwell refractory (no advance before firstDwellMs)", () => {
    const slow = { ...cfg, firstDwellMs: 10_000 };
    const m = new PlanMatcher(fps([1, 2, 3]), slow);
    let t = 0;
    for (let i = 0; i < 90; i++, t += 100) {
      m.pushFrame(frame(2), 0.5, t); // 9s of perfect pending audio, < firstDwell
    }
    expect(m.pointerIndex).toBe(0);
  });
});
