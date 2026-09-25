import { describe, expect, test } from "bun:test";
import fixtures from "./fixtures/pipeline-watch.json";
import {
  evaluatePipeline,
  type Marker,
  type PipelineSnapshot,
  type Stage,
  type StageVerdict,
} from "./pipeline-watch-evaluate";
import {
  acceptAlert,
  advanceCrawlSupply,
  advanceEmbedTrend,
  parseIncidentState,
  planIncidents,
} from "./pipeline-watch";

const asMarkers = (rows: { at: number; summary: Record<string, unknown> }[]): Marker[] => rows;

function snapshot(
  stage: Stage,
  markers: Marker[],
  options: Partial<PipelineSnapshot> = {},
): PipelineSnapshot {
  return {
    anchorQueue: 2000,
    budget: { closedReason: null, open: true, remainingBytes: 1_000_000_000, remainingTracks: 800 },
    crawl: { frontier: 2000, storable: 100, unstorable: 100 },
    crawlZeroChecks: 2,
    embedOldCapture: false,
    markers: {
      analyze: null,
      anchor: null,
      capture: null,
      crawl: null,
      embed: null,
      "funnel-snapshot": null,
      "isrc-recovery": null,
      [stage]: markers,
    },
    queues: { analyze: 5, capture: 5, embed: 5 },
    ...options,
  };
}

function evaluate(
  stage: Stage,
  markers: Marker[],
  options: Partial<PipelineSnapshot> = {},
  afterMs = 60_000,
): StageVerdict {
  const last = markers.at(-1);
  const now = new Date((last?.at ?? Date.parse("2026-09-25T00:31:00Z")) + afterMs);
  const verdict = evaluatePipeline(snapshot(stage, markers, options), now).find(
    (item) => item.stage === stage,
  );
  if (!verdict) {
    throw new Error(`missing ${stage}`);
  }
  return verdict;
}

describe("real box journal summary replay", () => {
  test("crawl's green zero-write window is blamed on the label gate that refused every find", () => {
    const markers = asMarkers(fixtures.crawlLabel).filter(
      ({ summary }) => summary.gateState === "active",
    );
    const verdict = evaluate("crawl", markers);
    expect(verdict.state).toBe("stalled");
    expect(verdict.cause).toBe("label_gate");
    expect(verdict.output).toBe(0);
  });

  test("a sweep that names its own blocker is believed over the counters", () => {
    const markers = asMarkers(fixtures.anchorGate).map((marker) => ({
      ...marker,
      summary: { ...marker.summary, blockedReason: "breaker_quota" },
    }));
    expect(evaluate("anchor", markers).cause).toBe("breaker_quota");
  });

  test("a budget with less than one file left is budget-bound even while it reads open", () => {
    const verdict = evaluate("capture", asMarkers(fixtures.captureBudget), {
      budget: { closedReason: null, open: true, remainingBytes: 4_000_000, remainingTracks: 800 },
    });
    expect(verdict.state).toBe("budget_closed");
  });

  test("an empty storable head against the measured frontier is a supply stall", () => {
    const verdict = evaluate("crawl", asMarkers(fixtures.crawlLabel), {
      crawl: { frontier: 183440, storable: 0, unstorable: 173754 },
    });
    expect(verdict.state).toBe("stalled");
    expect(verdict.cause).toBe("supply_empty");
    expect(verdict.message).toContain("173754");
  });

  test("anchor green deferrals expose the free Spotify vendor gate", () => {
    const verdict = evaluate("anchor", asMarkers(fixtures.anchorGate));
    expect(verdict.state).toBe("stalled");
    expect(verdict.cause).toBe("vendor_gate");
  });

  test("the Friday Amsterdam window pauses anchor without paging", () => {
    const markers = [
      { at: Date.parse("2026-07-24T05:00:00Z"), summary: { produced: 0, queueDepth: 2000 } },
    ];
    expect(evaluate("anchor", markers, {}, 60_000).state).toBe("scheduled_pause");
    expect(
      evaluate(
        "anchor",
        [{ at: Date.parse("2026-07-24T03:58:00Z"), summary: { produced: 0, queueDepth: 2000 } }],
        {},
        60_000,
      ).state,
    ).not.toBe("scheduled_pause");
    expect(
      evaluate(
        "anchor",
        [{ at: Date.parse("2026-07-24T06:59:00Z"), summary: { produced: 0, queueDepth: 2000 } }],
        {},
        60_000,
      ).state,
    ).not.toBe("scheduled_pause");
  });

  test("enrich repair pending remains a stall with a counted backlog", () => {
    const verdict = evaluate("analyze", asMarkers(fixtures.enrichRepair), {
      queues: { analyze: 100, capture: 5, embed: 5 },
    });
    expect(verdict.state).toBe("stalled");
    expect(verdict.cause).toBe("due_work_repair_pending");
  });

  test("green failed embed items become a conversion stall", () => {
    const verdict = evaluate("embed", asMarkers(fixtures.embedFailure));
    expect(verdict.state).toBe("stalled");
    expect(verdict.cause).toBe("conversion_fault");
  });

  test("zero capture with a shut budget stays informational", () => {
    const verdict = evaluate("capture", asMarkers(fixtures.captureBudget), {
      budget: { closedReason: "bytes_spent", open: false, remainingBytes: 0, remainingTracks: 100 },
    });
    expect(verdict.state).toBe("budget_closed");
    expect(planIncidents({}, [verdict], Date.now()).alerts).toEqual([]);
  });

  test("a missing UTC snapshot day stalls after 00:30", () => {
    const marker = [
      { at: Date.parse("2026-09-24T23:46:00Z"), summary: { day: "2026-09-23", ok: true } },
    ];
    const verdict = evaluate("funnel-snapshot", marker, {}, 45 * 60_000);
    expect(verdict.state).toBe("stalled");
    expect(verdict.cause).toBe("snapshot_missing");
  });
});

describe("tripwire boundaries", () => {
  test("productive windows and genuinely empty queues stay healthy", () => {
    const productive = asMarkers(fixtures.embedFailure).map((marker, index) => ({
      ...marker,
      summary: { ...marker.summary, done: index === 3 ? 1 : 0, produced: index === 3 ? 1 : 0 },
    }));
    expect(evaluate("embed", productive).state).toBe("healthy");
    expect(
      evaluate("embed", asMarkers(fixtures.embedFailure), {
        queues: { analyze: 5, capture: 5, embed: 0 },
      }).state,
    ).toBe("healthy");
    const crawl = asMarkers(fixtures.crawlLabel).map((marker, index) => ({
      ...marker,
      summary: { ...marker.summary, tracksWritten: index === 15 ? 1 : 0 },
    }));
    expect(evaluate("crawl", crawl).state).toBe("healthy");
    const anchor = asMarkers(fixtures.anchorGate).map((marker, index, rows) => ({
      ...marker,
      summary: { ...marker.summary, produced: index >= rows.length - 2 ? 10 : 0 },
    }));
    expect(evaluate("anchor", anchor).state).toBe("healthy");
    const capture = asMarkers(fixtures.captureBudget).map((marker, index) => ({
      ...marker,
      summary: { ...marker.summary, done: index === 10 ? 1 : 0, produced: index === 10 ? 1 : 0 },
    }));
    expect(evaluate("capture", capture).state).toBe("healthy");
    const analyze = asMarkers(fixtures.enrichRepair).map((marker, index) => ({
      ...marker,
      summary: { ...marker.summary, produced: index === 7 ? 1 : 0 },
    }));
    expect(evaluate("analyze", analyze).state).toBe("healthy");
  });

  test("embed capacity degrades after 24 hours of consecutive queue growth", () => {
    const start = Date.parse("2026-09-11T00:00:00Z");
    let trend = advanceEmbedTrend(null, 5, start);
    for (let tick = 1; tick <= 96; tick += 1) {
      trend = advanceEmbedTrend(trend, tick + 5, start + tick * 15 * 60_000);
    }
    expect(trend?.since).toBe(start);
    const recent = asMarkers(fixtures.embedFailure).map((marker, index) => ({
      at: start + 24 * 60 * 60_000 - (6 - index) * 5 * 60_000,
      summary: { ...marker.summary, done: index === 2 ? 1 : 0, produced: index === 2 ? 1 : 0 },
    }));
    const verdict = evaluate("embed", recent, {
      embedTrend: trend,
      queues: { analyze: 5, capture: 5, embed: 101 },
    });
    expect(verdict.state).toBe("degraded");
    expect(advanceEmbedTrend(trend, 100, start + 97 * 15 * 60_000)?.since).toBe(
      start + 15 * 60_000,
    );
    expect(advanceEmbedTrend(trend, null, start + 97 * 15 * 60_000)).toBeNull();
  });

  test("an old queued capture degrades embed even while some vectors land", () => {
    const productive = asMarkers(fixtures.embedFailure).map((marker, index) => ({
      ...marker,
      summary: { ...marker.summary, done: index === 3 ? 1 : 0, produced: index === 3 ? 1 : 0 },
    }));
    const verdict = evaluate("embed", productive, { embedOldCapture: true });
    expect(verdict.state).toBe("degraded");
    expect(verdict.cause).toBe("capacity_below_intake");
  });

  test("a failed read never becomes an empty queue", () => {
    const verdict = evaluate("embed", asMarkers(fixtures.embedFailure), {
      queues: { analyze: 5, capture: 5, embed: null },
    });
    expect(verdict.state).toBe("measurement_unavailable");
  });

  test("open, re-alert, delivery retry, and two-check recovery", () => {
    const bad = evaluate("embed", asMarkers(fixtures.embedFailure));
    const good = { ...bad, cause: "none", state: "healthy" as const };
    const start = Date.parse("2026-09-11T01:00:00Z");
    const opened = planIncidents({}, [bad], start);
    expect(opened.alerts.map((alert) => alert.type)).toEqual(["OPEN"]);
    const retry = planIncidents(opened.next, [bad], start + 15 * 60_000);
    expect(retry.alerts.map((alert) => alert.type)).toEqual(["OPEN"]);
    acceptAlert(
      retry.next,
      retry.alerts[0] as NonNullable<(typeof retry.alerts)[0]>,
      start + 15 * 60_000,
    );
    const hour = planIncidents(retry.next, [bad], start + 60 * 60_000);
    expect(hour.alerts.map((alert) => alert.type)).toEqual(["REMINDER"]);
    acceptAlert(
      hour.next,
      hour.alerts[0] as NonNullable<(typeof hour.alerts)[0]>,
      start + 60 * 60_000,
    );
    const fourHours = planIncidents(hour.next, [bad], start + 4 * 60 * 60_000);
    expect(fourHours.alerts.map((alert) => alert.type)).toEqual(["REMINDER"]);
    acceptAlert(
      fourHours.next,
      fourHours.alerts[0] as NonNullable<(typeof fourHours.alerts)[0]>,
      start + 4 * 60 * 60_000,
    );
    expect(
      planIncidents(fourHours.next, [bad], start + 28 * 60 * 60_000).alerts.map(
        (alert) => alert.type,
      ),
    ).toEqual(["REMINDER"]);
    const once = planIncidents(fourHours.next, [good], start + 28 * 60 * 60_000);
    expect(once.alerts).toEqual([]);
    const twice = planIncidents(once.next, [good], start + 28 * 60 * 60_000 + 15 * 60_000);
    expect(twice.alerts.map((alert) => alert.type)).toEqual(["RECOVERED"]);
    acceptAlert(
      twice.next,
      twice.alerts[0] as NonNullable<(typeof twice.alerts)[0]>,
      start + 28 * 60 * 60_000 + 15 * 60_000,
    );
    expect(twice.next).toEqual({});
  });
});

describe("paging policy", () => {
  const verdict = (state: StageVerdict["state"]): StageVerdict => ({
    backlog: 100,
    cause: state === "degraded" ? "capacity_below_intake" : "measurement_unavailable",
    message: "m",
    output: 0,
    stage: "embed",
    state,
    windowMs: 0,
  });

  test("embed capacity below intake is reported, never paged", () => {
    const start = Date.parse("2026-09-25T00:00:00Z");
    let state = {};
    for (let tick = 0; tick < 200; tick += 1) {
      const planned = planIncidents(state, [verdict("degraded")], start + tick * 15 * 60_000);
      expect(planned.alerts).toEqual([]);
      state = planned.next;
    }
  });

  test("a measurement gap stays quiet for its first hour, then pages", () => {
    const start = Date.parse("2026-09-25T00:00:00Z");
    const early = planIncidents({}, [verdict("measurement_unavailable")], start);
    expect(early.alerts).toEqual([]);
    const later = planIncidents(
      early.next,
      [verdict("measurement_unavailable")],
      start + 45 * 60_000,
    );
    expect(later.alerts).toEqual([]);
    const due = planIncidents(
      later.next,
      [verdict("measurement_unavailable")],
      start + 60 * 60_000,
    );
    expect(due.alerts.map((alert) => alert.type)).toEqual(["OPEN"]);
  });

  test("a gap that clears inside its grace never posts a recovery", () => {
    const start = Date.parse("2026-09-25T00:00:00Z");
    const gap = planIncidents({}, [verdict("measurement_unavailable")], start);
    const healthy = {
      ...verdict("measurement_unavailable"),
      cause: "none",
      state: "healthy" as const,
    };
    const once = planIncidents(gap.next, [healthy], start + 15 * 60_000);
    const twice = planIncidents(once.next, [healthy], start + 30 * 60_000);
    expect([...once.alerts, ...twice.alerts]).toEqual([]);
    expect(twice.next).toEqual({});
  });
});

describe("watchdog regression replays", () => {
  test("productive capture and embed windows tolerate yield and admission-skip summaries", () => {
    for (const stage of ["capture", "embed"] as const) {
      const source = stage === "capture" ? fixtures.captureBudget : fixtures.embedFailure;
      const markers = asMarkers(source).map((marker, index) => ({
        ...marker,
        summary:
          index === source.length - 3
            ? {
                checked: null,
                gateState: "admission-skipped",
                payloadStarted: false,
                produced: null,
              }
            : index === source.length - 2
              ? { gateState: "paused", produced: 0, reason: "database_admission" }
              : { ...marker.summary, produced: index === source.length - 4 ? 1 : 0 },
      }));
      expect(evaluate(stage, markers).state).toBe("healthy");
    }
  });

  test("an all-skip capture window is a stalled admission lane", () => {
    const markers = asMarkers(fixtures.captureBudget).map((marker) => ({
      ...marker,
      summary: {
        checked: null,
        gateState: "admission-skipped",
        payloadStarted: false,
        produced: null,
      },
    }));
    const verdict = evaluate("capture", markers);
    expect(verdict.state).toBe("stalled");
    expect(verdict.cause).toBe("admission_lane_closed");
  });

  test("paused anchor markers cannot erase the API backlog", () => {
    const start = Date.parse("2026-09-23T10:00:00Z");
    const markers = Array.from({ length: 3 }, (_, index) => ({
      at: start + index * 60 * 60_000,
      summary: { gateState: "paused", produced: 0, queueDepth: null, reason: "database_admission" },
    }));
    const verdict = evaluate("anchor", markers, { anchorQueue: 2000 } as Partial<PipelineSnapshot>);
    expect(verdict.state).toBe("stalled");
    expect(verdict.cause).toBe("admission_lane_closed");
    expect(verdict.backlog).toBe(2000);
    expect(
      evaluate("anchor", markers, { anchorQueue: null } as Partial<PipelineSnapshot>).state,
    ).toBe("measurement_unavailable");
  });

  test("a nonincident degraded span closes an announced stall before a new OPEN", () => {
    const start = Date.parse("2026-09-25T00:00:00Z");
    const stalled = evaluate("embed", asMarkers(fixtures.embedFailure));
    const degraded = { ...stalled, cause: "capacity_below_intake", state: "degraded" as const };
    const opened = planIncidents({}, [stalled], start);
    acceptAlert(opened.next, opened.alerts[0] as NonNullable<(typeof opened.alerts)[0]>, start);
    const first = planIncidents(opened.next, [degraded], start + 5 * 60 * 60_000);
    const second = planIncidents(first.next, [degraded], start + 5 * 60 * 60_000 + 15 * 60_000);
    expect(second.alerts.map((alert) => alert.type)).toEqual(["RECOVERED"]);
    acceptAlert(
      second.next,
      second.alerts[0] as NonNullable<(typeof second.alerts)[0]>,
      start + 5 * 60 * 60_000 + 15 * 60_000,
    );
    const again = planIncidents(second.next, [stalled], start + 10 * 60 * 60_000);
    expect(again.alerts.map((alert) => alert.type)).toEqual(["OPEN"]);
  });

  test("a changing crawl cause stays one incident and the reminder explains the change", () => {
    const start = Date.parse("2026-09-25T00:00:00Z");
    const label = evaluate("crawl", asMarkers(fixtures.crawlLabel));
    const admission = {
      ...label,
      cause: "admission_lane_closed",
      message: "crawl admission lane closed",
    };
    const opened = planIncidents({}, [label], start);
    acceptAlert(opened.next, opened.alerts[0] as NonNullable<(typeof opened.alerts)[0]>, start);
    const flipped = planIncidents(opened.next, [admission], start + 15 * 60_000);
    expect(flipped.alerts).toEqual([]);
    expect(Object.keys(flipped.next)).toEqual(["crawl"]);
    const reminder = planIncidents(flipped.next, [admission], start + 60 * 60_000);
    expect(reminder.alerts.map((alert) => alert.type)).toEqual(["REMINDER"]);
    expect(reminder.alerts[0]?.message).toContain("label_gate");
    expect(reminder.alerts[0]?.message).toContain("admission_lane_closed");
  });

  test("real capture and enrich gaps remain within the marker freshness budget", () => {
    const capture = evaluate(
      "capture",
      asMarkers(fixtures.captureBudget),
      {
        budget: {
          closedReason: "bytes_spent",
          open: false,
          remainingBytes: 0,
          remainingTracks: 10,
        },
      },
      18 * 60_000,
    );
    expect(capture.state).toBe("budget_closed");
    const enrich = evaluate("analyze", asMarkers(fixtures.enrichRepair), {}, 13 * 60_000);
    expect(enrich.state).toBe("stalled");
  });

  test("crawl needs two consecutive zero-storable readings", () => {
    const markers = asMarkers(fixtures.crawlLabel);
    const crawl = { frontier: 183440, storable: 0, unstorable: 173754 };
    const now = Date.parse("2026-09-25T12:00:00Z");
    const first = advanceCrawlSupply(null, 0, now);
    const second = advanceCrawlSupply(first, 0, now + 15 * 60_000);
    expect(first.checks).toBe(1);
    expect(second.checks).toBe(2);
    expect(advanceCrawlSupply(second, 1, now + 30 * 60_000).checks).toBe(0);
    expect(advanceCrawlSupply(first, 0, now + 45 * 60_000).checks).toBe(1);
    expect(evaluate("crawl", markers, { crawl, crawlZeroChecks: first.checks }).state).not.toBe(
      "stalled",
    );
    expect(evaluate("crawl", markers, { crawl, crawlZeroChecks: second.checks }).cause).toBe(
      "supply_empty",
    );
  });

  test("before 00:30 UTC the funnel keeps the previous day's missing verdict", () => {
    const marker = [
      { at: Date.parse("2026-09-24T23:46:00Z"), summary: { day: "2026-09-24", ok: true } },
    ];
    const verdict = evaluate("funnel-snapshot", marker, {}, 24 * 60_000);
    expect(verdict.state).toBe("stalled");
    expect(verdict.message).toContain("2026-09-23");
    expect(evaluate("funnel-snapshot", marker, {}, 45 * 60_000).state).toBe("healthy");
  });

  test("embed growth can span normal flat and falling ticks", () => {
    const start = Date.parse("2026-09-24T00:00:00Z");
    let trend = advanceEmbedTrend(null, 5, start);
    for (let tick = 1; tick <= 96; tick += 1) {
      trend = advanceEmbedTrend(trend, tick % 2 === 0 ? 10 : 9, start + tick * 15 * 60_000);
    }
    expect(trend?.since).toBe(start);
    expect(trend?.startingQueue).toBe(5);
  });

  test("a corrupt persisted incident entry is discarded without affecting other stages", () => {
    const start = Date.parse("2026-09-25T00:00:00Z");
    const healthy = {
      ...evaluate("embed", asMarkers(fixtures.embedFailure)),
      state: "healthy" as const,
    };
    const corrupt = { embed: { healthyChecks: "many", openedAt: "yesterday", sentAt: null } };
    const planned = planIncidents(
      corrupt as unknown as Record<
        string,
        { healthyChecks: number; openedAt: number; sentAt: number[] }
      >,
      [healthy],
      start,
    );
    expect(planned.alerts).toEqual([]);
    expect(planned.next).toEqual({});
    expect(parseIncidentState({ crawl: null, embed: { sentAt: "bad" } })).toEqual({});
  });
});
