import { describe, expect, it } from "vitest";
import {
  BOUNDARY_COMMIT_MS,
  BREATHER_FADE_IN_MS,
  BREATHER_FADE_OUT_MS,
  breatherDimAt,
  nextBoundaryEpochMs,
  OFFSET_SNAP_GRID_MS,
  type RadioScheduleEntry,
  radioBoundaryDecision,
  resolveRadioSlot,
  SEGMENT_FLOOR_MS,
  SEGMENT_STALE_AFTER_MS,
  segmentDurationMs,
  snapOffsetMs,
  totalLoopDurationMs,
} from "./radio-schedule";

// The shared-clock math (RFC radio-broadcast.md Unit A) is the load-bearing logic
// of the whole broadcast — server and client compute it identically off one
// epoch, so it MUST be tested in isolation, not only through the UI. The cases
// that matter: the cumulative-walk + modulo correctness; the empty pool (no
// divide-by-T); the single finding (n=1 loop forever); the duration floor; and
// growth at the NEXT boundary without a playhead jump.

function entry(trackId: string, observationDurationMs: number): RadioScheduleEntry {
  return { logId: `LOG-${trackId}`, observationDurationMs, trackId };
}

// A three-finding loop with distinct durations so a cumulative walk is exercised:
// 10s + 20s + 30s = 60s total.
const THREE = [entry("a", 10_000), entry("b", 20_000), entry("c", 30_000)];
const EPOCH = 1_000_000_000_000;

describe("segmentDurationMs", () => {
  it("returns the observation duration when it clears the floor", () => {
    expect(segmentDurationMs(entry("a", 30_000))).toBe(30_000);
  });

  it("floors a zero/sub-floor duration so a corrupt slot can't be zero-width", () => {
    expect(segmentDurationMs(entry("a", 0))).toBe(SEGMENT_FLOOR_MS);
    expect(segmentDurationMs(entry("a", 500))).toBe(SEGMENT_FLOOR_MS);
  });

  it("floors a non-finite duration", () => {
    expect(segmentDurationMs(entry("a", Number.NaN))).toBe(SEGMENT_FLOOR_MS);
  });
});

describe("totalLoopDurationMs", () => {
  it("sums the (floored) segment durations", () => {
    expect(totalLoopDurationMs(THREE)).toBe(60_000);
  });

  it("is zero for an empty schedule", () => {
    expect(totalLoopDurationMs([])).toBe(0);
  });
});

describe("resolveRadioSlot — the cumulative walk + modulo", () => {
  it("lands at offset 0 of the first finding at the epoch", () => {
    const slot = resolveRadioSlot(THREE, EPOCH, EPOCH);

    expect(slot?.currentIndex).toBe(0);
    expect(slot?.current.trackId).toBe("a");
    expect(slot?.offsetMs).toBe(0);
    expect(slot?.next.trackId).toBe("b");
    expect(slot?.nextIndex).toBe(1);
  });

  it("lands mid-first-segment 5s in", () => {
    const slot = resolveRadioSlot(THREE, EPOCH, EPOCH + 5_000);

    expect(slot?.current.trackId).toBe("a");
    expect(slot?.offsetMs).toBe(5_000);
  });

  it("walks into the second segment (past the first's 10s)", () => {
    const slot = resolveRadioSlot(THREE, EPOCH, EPOCH + 15_000);

    expect(slot?.current.trackId).toBe("b");
    expect(slot?.offsetMs).toBe(5_000); // 15s − 10s
    expect(slot?.next.trackId).toBe("c");
  });

  it("walks into the third segment and points next back to the first (wrap)", () => {
    const slot = resolveRadioSlot(THREE, EPOCH, EPOCH + 40_000);

    expect(slot?.current.trackId).toBe("c");
    expect(slot?.offsetMs).toBe(10_000); // 40s − 30s
    expect(slot?.next.trackId).toBe("a");
    expect(slot?.nextIndex).toBe(0);
  });

  it("wraps with the modulo: one full loop later is the same slot", () => {
    const base = resolveRadioSlot(THREE, EPOCH, EPOCH + 15_000);
    const wrapped = resolveRadioSlot(THREE, EPOCH, EPOCH + 15_000 + 60_000);

    expect(wrapped?.current.trackId).toBe(base?.current.trackId);
    expect(wrapped?.offsetMs).toBe(base?.offsetMs);
  });

  it("handles a now BEFORE the epoch (skewed clock / future epoch) without going negative", () => {
    // 5s before the epoch is 55s into the previous loop (third segment, 25s in).
    const slot = resolveRadioSlot(THREE, EPOCH, EPOCH - 5_000);

    expect(slot?.current.trackId).toBe("c");
    expect(slot?.offsetMs).toBe(25_000); // 55s − 30s
  });

  it("returns undefined for an empty schedule (never divides by T)", () => {
    expect(resolveRadioSlot([], EPOCH, EPOCH + 1_000)).toBeUndefined();
  });

  it("loops a single finding forever (n=1) with next pointing at itself", () => {
    const one = [entry("solo", 12_000)];
    const slot = resolveRadioSlot(one, EPOCH, EPOCH + 30_000); // 30 mod 12 = 6

    expect(slot?.current.trackId).toBe("solo");
    expect(slot?.offsetMs).toBe(6_000);
    expect(slot?.next.trackId).toBe("solo");
    expect(slot?.nextIndex).toBe(0);
  });

  it("uses the floored duration in the walk (a corrupt zero-width slot can't swallow the loop)", () => {
    const withZero = [entry("a", 0), entry("b", 10_000)];
    // Total = FLOOR + 10s. 1s in lands in the floored first segment.
    const slot = resolveRadioSlot(withZero, EPOCH, EPOCH + 1_000);

    expect(slot?.current.trackId).toBe("a");
    expect(slot?.currentDurationMs).toBe(SEGMENT_FLOOR_MS);
    expect(slot?.offsetMs).toBe(1_000);
  });
});

describe("nextBoundaryEpochMs — growth applies at a seam, no playhead jump", () => {
  it("rolls the epoch to the next loop boundary at/after now (old T)", () => {
    // Old loop = 60s; now is 95s in (loop 1, 35s deep). Next boundary is at +120s.
    const rolled = nextBoundaryEpochMs(EPOCH, 60_000, EPOCH + 95_000);

    expect(rolled).toBe(EPOCH + 120_000);
  });

  it("a listener riding the OLD loop sees no jump: their offset is continuous up to the seam", () => {
    const oldSet = THREE; // 60s loop
    const oldT = totalLoopDurationMs(oldSet);
    const now = EPOCH + 95_000;

    // Just before the roll, the listener is at a well-defined slot on the old loop.
    const before = resolveRadioSlot(oldSet, EPOCH, now);
    expect(before?.current.trackId).toBe("c"); // 95 mod 60 = 35 → 3rd segment (30-60)
    expect(before?.offsetMs).toBe(5_000); // 35s − 30s

    // The new (grown) schedule takes effect from the rolled epoch — which is in the
    // FUTURE relative to now — so until the seam the OLD schedule still governs and
    // the listener's current offset is unchanged by the reschedule.
    const rolledEpoch = nextBoundaryEpochMs(EPOCH, oldT, now);
    expect(rolledEpoch).toBeGreaterThan(now);

    // At the seam, the grown schedule starts cleanly at its own offset 0.
    const grown = [...oldSet, entry("d", 15_000)];
    const atSeam = resolveRadioSlot(grown, rolledEpoch, rolledEpoch);
    expect(atSeam?.current.trackId).toBe("a");
    expect(atSeam?.offsetMs).toBe(0);
  });

  it("leaves a fresh anchor (epoch already at/after now) unchanged", () => {
    expect(nextBoundaryEpochMs(EPOCH, 60_000, EPOCH)).toBe(EPOCH);
    expect(nextBoundaryEpochMs(EPOCH, 60_000, EPOCH - 1_000)).toBe(EPOCH);
  });

  it("falls back to now as a fresh anchor when the old loop was empty (T=0)", () => {
    const now = EPOCH + 5_000;
    expect(nextBoundaryEpochMs(EPOCH, 0, now)).toBe(now);
  });
});

describe("radioBoundaryDecision — clock-driven advance + hysteresis + self-heal (Bug A)", () => {
  const START = 1_000_000_000_000;
  const SEG = 20_000; // a 20s observation segment.

  it("holds in the calm middle of a segment", () => {
    expect(radioBoundaryDecision(START, SEG, START + 10_000)).toBe("hold");
  });

  it("holds right at the end and just past it (hysteresis: the seam can't flip back)", () => {
    expect(radioBoundaryDecision(START, SEG, START + SEG)).toBe("hold");
    // A sub-commit overshoot rides instead of advancing — no oscillation N↔N+1.
    expect(radioBoundaryDecision(START, SEG, START + SEG + BOUNDARY_COMMIT_MS - 1)).toBe("hold");
  });

  it("advances once past the end by the commit margin (the normal hand-off)", () => {
    expect(radioBoundaryDecision(START, SEG, START + SEG + BOUNDARY_COMMIT_MS)).toBe("advance");
    expect(radioBoundaryDecision(START, SEG, START + SEG + 1_000)).toBe("advance");
  });

  it("resyncs when far past the end with no advance (a wedge self-heals, no refresh)", () => {
    expect(radioBoundaryDecision(START, SEG, START + SEG + SEGMENT_STALE_AFTER_MS)).toBe("resync");
    expect(radioBoundaryDecision(START, SEG, START + SEG + 60_000)).toBe("resync");
  });

  it("resyncs when the on-screen segment hasn't started yet (a skew overshoot of the seam)", () => {
    expect(radioBoundaryDecision(START, SEG, START - BOUNDARY_COMMIT_MS - 1)).toBe("resync");
    // A hair before the start still holds (within the commit band, no flip-back).
    expect(radioBoundaryDecision(START, SEG, START - BOUNDARY_COMMIT_MS + 1)).toBe("hold");
  });
});

describe("breatherDimAt — the deterministic inter-clip fade (Feature B)", () => {
  const SEG = 20_000;

  it("is clear (0) in the calm middle of a segment", () => {
    expect(breatherDimAt(SEG / 2, SEG)).toBe(0);
  });

  it("is fully black at the exact seam (end of segment / start of next)", () => {
    expect(breatherDimAt(SEG, SEG)).toBe(1); // end of the ending segment
    expect(breatherDimAt(0, SEG)).toBe(1); // head of the new segment
  });

  it("ramps to black over the final fade-out window of the ending segment", () => {
    expect(breatherDimAt(SEG - BREATHER_FADE_OUT_MS, SEG)).toBe(0);
    expect(breatherDimAt(SEG - BREATHER_FADE_OUT_MS / 2, SEG)).toBeCloseTo(0.5, 5);
  });

  it("lifts from black over the fade-in window of the new segment", () => {
    expect(breatherDimAt(BREATHER_FADE_IN_MS, SEG)).toBe(0);
    expect(breatherDimAt(BREATHER_FADE_IN_MS / 2, SEG)).toBeCloseTo(0.5, 5);
  });

  it("never returns outside [0, 1]", () => {
    for (const offset of [-100, 0, 500, SEG - 1, SEG, SEG + 100]) {
      const dim = breatherDimAt(offset, SEG);
      expect(dim).toBeGreaterThanOrEqual(0);
      expect(dim).toBeLessThanOrEqual(1);
    }
  });
});

describe("snapOffsetMs — the cache-fragmentation fix", () => {
  it("snaps down to the 10s grid by default", () => {
    expect(snapOffsetMs(0)).toBe(0);
    expect(snapOffsetMs(9_999)).toBe(0);
    expect(snapOffsetMs(10_000)).toBe(10_000);
    expect(snapOffsetMs(43_210)).toBe(40_000);
  });

  it("exposes the grid constant it snaps to", () => {
    expect(OFFSET_SNAP_GRID_MS).toBe(10_000);
  });

  it("never returns a negative offset", () => {
    expect(snapOffsetMs(-5_000)).toBe(0);
  });
});
