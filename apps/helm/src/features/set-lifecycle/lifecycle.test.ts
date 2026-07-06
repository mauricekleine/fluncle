import { describe, expect, test } from "bun:test";

import { canRunOn, cueCount, groupByStage, type Recording, stageOf } from "./lifecycle";

function recording(partial: Partial<Recording>): Recording {
  return {
    createdAt: "2026-07-05T00:00:00.000Z",
    hasVideo: false,
    id: partial.id ?? "r1",
    title: "A set",
    updatedAt: "2026-07-05T00:00:00.000Z",
    version: 1,
    ...partial,
  };
}

describe("stageOf (the lifecycle mapping)", () => {
  test("a videoless recording is a PLAN", () => {
    expect(stageOf({ hasVideo: false })).toBe("plan");
  });

  test("a recording with a set video is a TAKE", () => {
    expect(stageOf({ hasVideo: true })).toBe("take");
  });

  test("a recording with a minted Log ID is PROMOTED — logId wins over video", () => {
    expect(stageOf({ hasVideo: true, logId: "042.F.03" })).toBe("promoted");
    // Defensive: an empty logId string is not a promotion.
    expect(stageOf({ hasVideo: true, logId: "" })).toBe("take");
  });
});

describe("groupByStage (the board's lanes)", () => {
  test("splits the shelf into plan / take / promoted, order preserved per lane", () => {
    const shelf: Recording[] = [
      recording({ hasVideo: false, id: "plan-a" }),
      recording({ hasVideo: true, id: "take-a" }),
      recording({ hasVideo: true, id: "promoted-a", logId: "042.F.03" }),
      recording({ hasVideo: true, id: "take-b" }),
      recording({ hasVideo: false, id: "plan-b" }),
    ];
    const groups = groupByStage(shelf);

    expect(groups.plan.map((r) => r.id)).toEqual(["plan-a", "plan-b"]);
    expect(groups.take.map((r) => r.id)).toEqual(["take-a", "take-b"]);
    expect(groups.promoted.map((r) => r.id)).toEqual(["promoted-a"]);
  });

  test("an empty shelf yields three empty lanes", () => {
    expect(groupByStage([])).toEqual({ plan: [], promoted: [], take: [] });
  });
});

describe("canRunOn (action-level machine gating)", () => {
  test("a known machine runs only its own actions", () => {
    expect(canRunOn("m5", "m5")).toBe(true);
    expect(canRunOn("m5", "m2")).toBe(false);
    expect(canRunOn("m2", "m2")).toBe(true);
    expect(canRunOn("m2", "m5")).toBe(false);
  });

  test("an unknown machine is never locked out — it runs everything", () => {
    expect(canRunOn("unknown", "m5")).toBe(true);
    expect(canRunOn("unknown", "m2")).toBe(true);
  });
});

describe("cueCount", () => {
  test("counts the tracklist, zero when absent", () => {
    expect(cueCount({ tracklist: [{}, {}, {}] })).toBe(3);
    expect(cueCount({ tracklist: [] })).toBe(0);
    expect(cueCount({})).toBe(0);
  });
});
