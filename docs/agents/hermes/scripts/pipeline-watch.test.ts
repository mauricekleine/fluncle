import { describe, expect, test } from "bun:test";
import fixtures from "./fixtures/pipeline-watch.json";
import {
  evaluatePipeline,
  type Marker,
  type PipelineSnapshot,
  type Stage,
  type StageVerdict,
} from "./pipeline-watch-evaluate";
import { acceptAlert, advanceEmbedTrend, planIncidents } from "./pipeline-watch";

const asMarkers = (rows: { at: number; summary: Record<string, unknown> }[]): Marker[] => rows;

function snapshot(
  stage: Stage,
  markers: Marker[],
  options: Partial<PipelineSnapshot> = {},
): PipelineSnapshot {
  return {
    budget: { closedReason: null, open: true, remainingBytes: 1_000_000_000, remainingTracks: 800 },
    crawl: { frontier: 2000, storable: 100, unstorable: 100 },
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
    quiesced: false,
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
      summary: { ...marker.summary, done: index === 3 ? 1 : 0 },
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
      summary: { ...marker.summary, done: index === 10 ? 1 : 0 },
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
      summary: { ...marker.summary, done: index === 2 ? 1 : 0 },
    }));
    const verdict = evaluate("embed", recent, {
      embedTrend: trend,
      queues: { analyze: 5, capture: 5, embed: 101 },
    });
    expect(verdict.state).toBe("degraded");
    expect(advanceEmbedTrend(trend, 100, start + 97 * 15 * 60_000)?.since).toBe(
      start + 97 * 15 * 60_000,
    );
    expect(advanceEmbedTrend(trend, null, start + 97 * 15 * 60_000)).toBeNull();
  });

  test("an old queued capture degrades embed even while some vectors land", () => {
    const productive = asMarkers(fixtures.embedFailure).map((marker, index) => ({
      ...marker,
      summary: { ...marker.summary, done: index === 3 ? 1 : 0 },
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
