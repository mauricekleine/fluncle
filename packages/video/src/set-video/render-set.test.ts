import { describe, expect, test } from "bun:test";

import { buildChapterPlan, chunkRanges } from "./render-set";

describe("buildChapterPlan", () => {
  test("makes contiguous chapters covering [0, setDuration], mix-in preserved", () => {
    const plan = buildChapterPlan(
      [
        { bestMs: 65_500, logId: "A" },
        { bestMs: 588_300, logId: "B" },
        { bestMs: 775_800, logId: "C" },
      ],
      1_000_000,
    );
    expect(plan).toEqual([
      { endMs: 588_300, logId: "A", mixInMs: 65_500, startMs: 0 },
      { endMs: 775_800, logId: "B", mixInMs: 588_300, startMs: 588_300 },
      { endMs: 1_000_000, logId: "C", mixInMs: 775_800, startMs: 775_800 },
    ]);
    // Contiguous, no gaps.
    for (let i = 1; i < plan.length; i += 1) {
      expect(plan[i]?.startMs).toBe(plan[i - 1]?.endMs);
    }
  });

  test("sorts out-of-order anchors and dedupes fingerprint ties", () => {
    // Models the real 019.F.1A noise: an out-of-order anchor + a duplicate ms.
    const plan = buildChapterPlan(
      [
        { bestMs: 3_488_000, logId: "late-1" },
        { bestMs: 3_488_000, logId: "late-2-tie" }, // exact tie — dropped
        { bestMs: 2_971_000, logId: "out-of-order" }, // sorts before the late ones
      ],
      4_000_000,
    );
    expect(plan.map((c) => c.logId)).toEqual(["out-of-order", "late-1"]);
    expect(plan[0]?.startMs).toBe(0);
  });

  test("drops chapters shorter than the floor", () => {
    const plan = buildChapterPlan(
      [
        { bestMs: 0, logId: "A" },
        { bestMs: 2_000, logId: "B-too-close" },
      ],
      100_000,
      8_000,
    );
    expect(plan.map((c) => c.logId)).toEqual(["A"]);
  });
});

describe("chunkRanges", () => {
  test("splits into inclusive frame ranges", () => {
    expect(chunkRanges(100, 40)).toEqual([
      [0, 39],
      [40, 79],
      [80, 99],
    ]);
  });

  test("single chunk when total fits", () => {
    expect(chunkRanges(30, 100)).toEqual([[0, 29]]);
  });
});
