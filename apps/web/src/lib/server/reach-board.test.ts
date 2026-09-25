import { describe, expect, it } from "vitest";
import {
  buildPivots,
  dailyViewVelocity,
  dayGap,
  type ReachPivot,
  type ReachPivotCell,
  type ReachPostRow,
  type ReachSource,
} from "./reach-board";

function firstCell(pivot: ReachPivot): ReachPivotCell {
  const cell = pivot.cells[0];

  if (!cell) {
    throw new Error("expected at least one pivot cell");
  }

  return cell;
}

function post(overrides: Partial<ReachPostRow> = {}): ReachPostRow {
  return {
    artists: [],
    averageViewDurationSeconds: null,
    averageViewPercentage: null,
    capturedDay: "2026-07-20",
    comments: null,
    dailyViewVelocity: null,
    externalId: "ext-1",
    likes: null,
    logId: null,
    plateSubject: null,
    platform: "youtube",
    publishedAt: null,
    series: [],
    shares: null,
    snapshotCount: 1,
    source: "postiz",
    structure: null,
    title: null,
    trackId: "trk-1",
    url: null,
    velocityDaySpan: null,
    velocityViewsDelta: null,
    views: null,
    watchTimeSeconds: null,
    ...overrides,
  };
}

describe("dayGap", () => {
  it("counts whole UTC days between two yyyy-mm-dd days", () => {
    expect(dayGap("2026-07-20", "2026-07-21")).toBe(1);
    expect(dayGap("2026-07-20", "2026-07-27")).toBe(7);
    expect(dayGap("2026-07-20", "2026-07-20")).toBe(0);
  });

  it("crosses a month boundary correctly", () => {
    expect(dayGap("2026-07-30", "2026-08-02")).toBe(3);
  });
});

describe("dailyViewVelocity", () => {
  it("is a plain per-day rate over consecutive snapshots", () => {
    const result = dailyViewVelocity({
      latestDay: "2026-07-21",
      latestViews: 1500,
      prevDay: "2026-07-20",
      prevViews: 1000,
    });

    expect(result).toEqual({
      dailyViewVelocity: 500,
      velocityDaySpan: 1,
      velocityViewsDelta: 500,
    });
  });

  it("normalises across GAP DAYS so a missed tick never inflates the rate", () => {
    const result = dailyViewVelocity({
      latestDay: "2026-07-24",
      latestViews: 1900,
      prevDay: "2026-07-20",
      prevViews: 1000,
    });

    expect(result.velocityDaySpan).toBe(4);
    expect(result.velocityViewsDelta).toBe(900);
    expect(result.dailyViewVelocity).toBe(225);
  });

  it("is null for a post with ONE snapshot (no previous point)", () => {
    const result = dailyViewVelocity({
      latestDay: "2026-07-20",
      latestViews: 1000,
      prevDay: null,
      prevViews: null,
    });

    expect(result).toEqual({
      dailyViewVelocity: null,
      velocityDaySpan: null,
      velocityViewsDelta: null,
    });
  });

  it("is null when the latest view count is unreported", () => {
    const result = dailyViewVelocity({
      latestDay: "2026-07-21",
      latestViews: null,
      prevDay: "2026-07-20",
      prevViews: 1000,
    });

    expect(result.dailyViewVelocity).toBeNull();
  });

  it("carries a negative delta when a count is revised down", () => {
    const result = dailyViewVelocity({
      latestDay: "2026-07-21",
      latestViews: 800,
      prevDay: "2026-07-20",
      prevViews: 1000,
    });

    expect(result.velocityViewsDelta).toBe(-200);
    expect(result.dailyViewVelocity).toBe(-200);
  });

  it("never divides by zero if two snapshots share a day", () => {
    const result = dailyViewVelocity({
      latestDay: "2026-07-20",
      latestViews: 1200,
      prevDay: "2026-07-20",
      prevViews: 1000,
    });

    expect(result.velocityDaySpan).toBe(1);
    expect(result.dailyViewVelocity).toBe(200);
  });
});

describe("buildPivots", () => {
  it("groups posts by platform × structure, with mean, median, and post count", () => {
    const posts = [
      post({ platform: "youtube", structure: "flow", trackId: "a", views: 100 }),
      post({ platform: "youtube", structure: "flow", trackId: "b", views: 300 }),
      post({ platform: "youtube", structure: "flow", trackId: "c", views: 200 }),
    ];

    const { structure } = buildPivots(posts);
    const cell = structure.cells.find((c) => c.value === "flow" && c.platform === "youtube");

    expect(cell).toBeDefined();
    expect(cell?.count).toBe(3);
    expect(cell?.meanViews).toBe(200);
    expect(cell?.medianViews).toBe(200);
  });

  it("computes the median as the mean of the two middles for an even count", () => {
    const posts = [
      post({ platform: "tiktok", structure: "cellular", trackId: "a", views: 10 }),
      post({ platform: "tiktok", structure: "cellular", trackId: "b", views: 20 }),
      post({ platform: "tiktok", structure: "cellular", trackId: "c", views: 30 }),
      post({ platform: "tiktok", structure: "cellular", trackId: "d", views: 100 }),
    ];

    const cell = firstCell(buildPivots(posts).structure);

    expect(cell.count).toBe(4);
    expect(cell.medianViews).toBe(25);
    expect(cell.meanViews).toBe(40);
  });

  it("keeps a small-n cell readable — a lone post is count 1, not a trend", () => {
    const posts = [
      post({ platform: "youtube", structure: "flow", trackId: "a", views: 5000 }),
      post({ platform: "youtube", structure: "lattice", trackId: "b", views: 100 }),
      post({ platform: "youtube", structure: "lattice", trackId: "c", views: 120 }),
    ];

    const { structure } = buildPivots(posts);
    const flow = structure.cells.find((c) => c.value === "flow");
    const lattice = structure.cells.find((c) => c.value === "lattice");

    expect(flow?.count).toBe(1);
    expect(lattice?.count).toBe(2);
  });

  it("buckets posts with no axis value under '—'", () => {
    const posts = [
      post({ plateSubject: null, platform: "tiktok", trackId: "a", views: 40 }),
      post({ plateSubject: "hull", platform: "tiktok", trackId: "b", views: 80 }),
    ];

    const { plateSubject } = buildPivots(posts);

    expect(plateSubject.cells.find((c) => c.value === "—")?.count).toBe(1);
    expect(plateSubject.cells.find((c) => c.value === "hull")?.count).toBe(1);
  });

  it("dedupes a post carrying two sources to ONE unit, preferring native views", () => {
    const shared = { platform: "youtube" as const, structure: "flow", trackId: "same" };
    const posts = [
      post({ ...shared, source: "postiz", views: 900 }),
      post({
        ...shared,
        averageViewPercentage: 62,
        source: "youtube_analytics" as ReachSource,
        views: 1000,
      }),
    ];

    const cell = firstCell(buildPivots(posts).structure);

    expect(cell.count).toBe(1);
    expect(cell.meanViews).toBe(1000);
    expect(cell.meanRetention).toBe(62);
    expect(cell.retentionCount).toBe(1);
  });

  it("reports mean retention only over cells that carry a reading", () => {
    const posts = [
      post({
        averageViewPercentage: 50,
        platform: "youtube",
        source: "youtube_analytics",
        structure: "flow",
        trackId: "a",
        views: 100,
      }),
      post({
        averageViewPercentage: 70,
        platform: "youtube",
        source: "youtube_analytics",
        structure: "flow",
        trackId: "b",
        views: 200,
      }),
      post({ platform: "youtube", source: "postiz", structure: "flow", trackId: "c", views: 300 }),
    ];

    const cell = firstCell(buildPivots(posts).structure);

    expect(cell.count).toBe(3);
    expect(cell.retentionCount).toBe(2);
    expect(cell.meanRetention).toBe(60);
  });

  it("leaves mean retention null when no post in a cell reported it", () => {
    const posts = [post({ platform: "tiktok", structure: "cellular", trackId: "a", views: 10 })];

    expect(firstCell(buildPivots(posts).structure).meanRetention).toBeNull();
  });
});
