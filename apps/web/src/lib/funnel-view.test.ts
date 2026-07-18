import { describe, expect, it } from "vitest";
import {
  type CatalogueSnapshotRow,
  type FunnelQueues,
  type FunnelStages,
} from "@/lib/server/funnel";
import {
  CHART_H,
  CHART_W,
  chartGeometry,
  growthPoints,
  latestThroughput,
  stageBars,
} from "@/lib/funnel-view";

// A fully-populated stage set, biggest at the top of the funnel and tapering to the exit —
// the honest shape of a real catalogue (many crawled, few certified).
const STAGES: FunnelStages = {
  analyzed: 300,
  anchored: 500,
  captured: 400,
  certified: 50,
  crawled: 1000,
  embedded: 250,
  recEligible: 120,
};

const QUEUES: FunnelQueues = {
  analyzeQueue: 30,
  anchorBackoff: 7,
  anchorQueueIsrc: 40,
  anchorQueueNoIsrc: 10,
  captureQueue: 90,
  embedQueue: 20,
};

/** A snapshot row from a fixed base, so a test can add just the deltas it cares about. */
function snapshot(day: string, over: Partial<CatalogueSnapshotRow>): CatalogueSnapshotRow {
  return {
    analyzeQueue: 0,
    analyzed: 0,
    anchorBackoff: 0,
    anchorQueueIsrc: 0,
    anchorQueueNoIsrc: 0,
    anchored: 0,
    captureQueue: 0,
    captured: 0,
    certified: 0,
    crawled: 0,
    createdAt: `${day}T00:00:00.000Z`,
    day,
    embedQueue: 0,
    embedded: 0,
    frontierDone: 0,
    frontierPending: 0,
    recEligible: 0,
    ...over,
  };
}

describe("stageBars", () => {
  it("orders the stages crawl → certified and links each to its operating surface", () => {
    const bars = stageBars(STAGES, QUEUES);

    expect(bars.map((bar) => bar.key)).toEqual([
      "crawled",
      "anchored",
      "captured",
      "analyzed",
      "embedded",
      "recEligible",
      "certified",
    ]);
    expect(bars[0]?.link).toEqual({ lens: "ear", to: "/admin/catalogue" });
    expect(bars.find((bar) => bar.key === "captured")?.link).toEqual({
      lens: "capture",
      to: "/admin/catalogue",
    });
    expect(bars.find((bar) => bar.key === "certified")?.link).toEqual({ to: "/admin/findings" });
  });

  it("gives honest proportional widths against the widest stage", () => {
    const bars = stageBars(STAGES, QUEUES);
    const byKey = Object.fromEntries(bars.map((bar) => [bar.key, bar]));

    // Crawled is the widest, so it reads full width; the rest are its fraction.
    expect(byKey.crawled?.widthPct).toBe(100);
    expect(byKey.anchored?.widthPct).toBeCloseTo(50);
    expect(byKey.certified?.widthPct).toBeCloseTo(5);
  });

  it("carries the drain queue behind the stages that have one and undefined elsewhere", () => {
    const bars = stageBars(STAGES, QUEUES);
    const byKey = Object.fromEntries(bars.map((bar) => [bar.key, bar]));

    // Anchor's queued-behind folds both verification paths (ISRC + no-ISRC).
    expect(byKey.anchored?.queued).toBe(50);
    expect(byKey.captured?.queued).toBe(90);
    expect(byKey.analyzed?.queued).toBe(30);
    expect(byKey.embedded?.queued).toBe(20);
    // Crawled, rec-eligible and certified have no drain worklist behind them.
    expect(byKey.crawled?.queued).toBeUndefined();
    expect(byKey.recEligible?.queued).toBeUndefined();
    expect(byKey.certified?.queued).toBeUndefined();
  });

  it("guards divide-by-zero: an all-empty pipeline is every width 0, never NaN", () => {
    const empty: FunnelStages = {
      analyzed: 0,
      anchored: 0,
      captured: 0,
      certified: 0,
      crawled: 0,
      embedded: 0,
      recEligible: 0,
    };
    const bars = stageBars(empty, QUEUES);

    for (const bar of bars) {
      expect(bar.widthPct).toBe(0);
      expect(Number.isNaN(bar.widthPct)).toBe(false);
    }
  });
});

describe("latestThroughput", () => {
  it("returns undefined with zero or one snapshot (a delta needs two readings)", () => {
    expect(latestThroughput([])).toBeUndefined();
    expect(latestThroughput([snapshot("2026-07-18", { crawled: 10 })])).toBeUndefined();
  });

  it("computes per-stage movement across the newest consecutive pair", () => {
    const series = [
      snapshot("2026-07-16", { captured: 100 }),
      snapshot("2026-07-17", { analyzed: 10, captured: 1000, crawled: 5000 }),
      snapshot("2026-07-18", { analyzed: 200, captured: 5900, crawled: 5000 }),
    ];

    const throughput = latestThroughput(series);

    expect(throughput?.from).toBe("2026-07-17");
    expect(throughput?.to).toBe("2026-07-18");
    const byKey = Object.fromEntries(throughput?.stages.map((s) => [s.key, s.delta]) ?? []);
    // The pinched-pipe glance: capture moved 4,900 while analyze moved 190.
    expect(byKey.captured).toBe(4900);
    expect(byKey.analyzed).toBe(190);
    // A stage that did not move reads a flat 0, and a shrink reads negative honestly.
    expect(byKey.crawled).toBe(0);
  });

  it("reports a negative delta when a pool shrinks", () => {
    const series = [
      snapshot("2026-07-17", { recEligible: 120 }),
      snapshot("2026-07-18", { recEligible: 100 }),
    ];

    const byKey = Object.fromEntries(
      latestThroughput(series)?.stages.map((s) => [s.key, s.delta]) ?? [],
    );
    expect(byKey.recEligible).toBe(-20);
  });
});

describe("growthPoints", () => {
  it("extracts a stage's value per day, oldest-first", () => {
    const series = [
      snapshot("2026-07-17", { crawled: 4000 }),
      snapshot("2026-07-18", { crawled: 5000 }),
    ];

    expect(growthPoints(series, "crawled")).toEqual([
      { at: "2026-07-17", value: 4000 },
      { at: "2026-07-18", value: 5000 },
    ]);
  });

  it("is empty for an empty series", () => {
    expect(growthPoints([], "crawled")).toEqual([]);
  });
});

describe("chartGeometry", () => {
  it("pins a single point to the live edge without drawing a line", () => {
    const geometry = chartGeometry([{ at: "2026-07-18", value: 42 }]);

    expect(geometry.last.x).toBe(CHART_W);
    expect(geometry.last.y).toBe(CHART_H / 2);
    expect(geometry.max).toBe(42);
    expect(geometry.min).toBe(42);
  });

  it("handles an empty series with no NaN and an empty area path", () => {
    const geometry = chartGeometry([]);

    expect(geometry.line).toBe("");
    expect(geometry.area).toBe("");
    expect(Number.isNaN(geometry.last.x)).toBe(false);
    expect(Number.isNaN(geometry.last.y)).toBe(false);
  });

  it("spreads multiple points across the width and inverts value into height", () => {
    const geometry = chartGeometry([
      { at: "2026-07-16", value: 0 },
      { at: "2026-07-17", value: 50 },
      { at: "2026-07-18", value: 100 },
    ]);

    // First point at x=0, last at the full width (the live edge).
    expect(geometry.line.startsWith("0,")).toBe(true);
    expect(geometry.last.x).toBe(CHART_W);
    // Highest value sits highest on screen (smallest y); lowest sits lowest.
    expect(geometry.last.y).toBeLessThan(CHART_H / 2);
    expect(geometry.min).toBe(0);
    expect(geometry.max).toBe(100);
  });

  it("draws a flat series down the middle (span 0, no divide-by-zero)", () => {
    const geometry = chartGeometry([
      { at: "2026-07-17", value: 7 },
      { at: "2026-07-18", value: 7 },
    ]);

    expect(geometry.last.y).toBe(CHART_H / 2);
    expect(Number.isNaN(geometry.last.y)).toBe(false);
  });
});
