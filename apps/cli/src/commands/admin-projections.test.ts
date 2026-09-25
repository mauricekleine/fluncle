import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

const calls: { body?: unknown; method: string; path: string }[] = [];
const postResponses: unknown[] = [];
const status = {
  cutovers: { crawlDueWork: false, publicProjections: false, trackDueWork: false },
  projections: {
    artistQualification: family(true),
    crawlDueWork: family(false),
    publicAggregates: { ...family(true), anchorsReady: true },
    trackDueWork: family(true),
  },
  readyToOpen: { crawlDueWork: false, publicProjections: true, trackDueWork: true },
};

function family(ready: boolean) {
  return {
    backlog: {
      leased: { count: 0, truncated: false },
      ready: { count: 2, truncated: false },
      scheduled: { count: 1, truncated: false },
    },
    convergence: {
      digestMatched: ready,
      epochMatched: ready,
      projectedDigest: ready ? "b".repeat(64) : null,
      projectedEpoch: ready ? 4 : null,
      sourceDigest: ready ? "b".repeat(64) : null,
      sourceEpoch: ready ? 4 : null,
    },
    oldestOutstandingMarkerAge: { ageMs: null, reason: null, truncated: false },
    ready,
    rebuild: {
      complete: ready,
      completed: ready ? 1 : 0,
      projected: 3,
      running: 0,
      scanned: 4,
      total: 1,
    },
    repairs: {
      direct: { count: ready ? 0 : 1, truncated: false },
      fanout: { count: 0, truncated: false },
      total: { count: ready ? 0 : 1, truncated: false },
    },
  };
}

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    calls.push({ method: "GET", path });
    return { ok: true, status };
  },
  adminApiPost: async (path: string, body: unknown) => {
    calls.push({ body, method: "POST", path });
    const queued = postResponses.shift();
    if (queued instanceof Error) {
      throw queued;
    }
    if (queued !== undefined) {
      return queued;
    }
    return {
      ...(body as Record<string, unknown>),
      complete: false,
      ok: true,
      processed: 10,
      scheduled: 1,
      status,
    };
  },
  adminApiPut: async (path: string, body: unknown) => {
    calls.push({ body, method: "PUT", path });
    return { ...(body as Record<string, unknown>), ok: true, status };
  },
}));

const projections = await import("./admin-projections");

beforeEach(() => {
  calls.length = 0;
  postResponses.length = 0;
});

describe("projection operator commands", () => {
  test("keeps status, bounded steps, and cutover writes on fixed transports", async () => {
    await projections.getProjectionStatusCommand();
    await projections.advanceProjectionCommand({
      action: "repair",
      limit: 25,
      target: "crawl_due_work",
    });
    await projections.setProjectionCutoverCommand({ enabled: false, target: "public_projections" });

    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/admin/projections/status" },
      {
        body: { action: "repair", limit: 25 },
        method: "POST",
        path: "/api/v1/admin/projections/crawl_due_work/advance",
      },
      {
        body: { enabled: false },
        method: "PUT",
        path: "/api/v1/admin/projections/public_projections/cutover",
      },
    ]);
  });

  test("defaults advance to one call and returns the one-step total", async () => {
    postResponses.push({
      action: "repair",
      complete: false,
      ok: true,
      processed: 10,
      scheduled: 1,
      status,
      target: "crawl_due_work",
    });

    const result = await projections.advanceProjectionCommand({
      action: "repair",
      limit: 25,
      target: "crawl_due_work",
    });

    expect(result).toEqual({
      action: "repair",
      complete: false,
      ok: true,
      processed: 10,
      scheduled: 1,
      status,
      steps: 1,
      target: "crawl_due_work",
      wallStopped: false,
    });
    expect(calls).toEqual([
      {
        body: { action: "repair", limit: 25 },
        method: "POST",
        path: "/api/v1/admin/projections/crawl_due_work/advance",
      },
    ]);
  });

  test("stops after a completing response", async () => {
    postResponses.push(
      {
        action: "audit",
        complete: true,
        ok: true,
        processed: 4,
        scheduled: 0,
        target: "public_aggregates",
      },
      {
        action: "audit",
        complete: false,
        ok: true,
        processed: 99,
        scheduled: 99,
        status,
        target: "public_aggregates",
      },
    );

    const result = await projections.advanceProjectionCommand({
      action: "audit",
      limit: 50,
      maxSteps: 5,
      target: "public_aggregates",
    });

    expect(result.steps).toBe(1);
    expect(result.processed).toBe(4);
    expect(result.scheduled).toBe(0);
    expect(result.status).toBe(status);
    expect(calls).toEqual([
      {
        body: { action: "audit", includeStatus: false, limit: 50 },
        method: "POST",
        path: "/api/v1/admin/projections/public_aggregates/advance",
      },
      { method: "GET", path: "/api/v1/admin/projections/status" },
    ]);
  });

  test("aggregates exhausted steps and preserves the final payload", async () => {
    postResponses.push(
      {
        action: "rebuild",
        complete: false,
        ok: true,
        processed: 2,
        scheduled: 3,
        target: "track_due_work",
      },
      {
        action: "rebuild",
        complete: false,
        ok: true,
        processed: 5,
        scheduled: 7,
        target: "track_due_work",
      },
      {
        action: "rebuild",
        complete: false,
        ok: true,
        processed: 11,
        scheduled: 13,
        target: "track_due_work",
      },
    );

    const result = await projections.advanceProjectionCommand({
      action: "rebuild",
      limit: 100,
      maxSteps: 3,
      target: "track_due_work",
    });

    expect(result).toEqual({
      action: "rebuild",
      complete: false,
      ok: true,
      processed: 18,
      scheduled: 23,
      status,
      steps: 3,
      target: "track_due_work",
      wallStopped: false,
    });
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.body)).toEqual([
      { action: "rebuild", includeStatus: false, limit: 100 },
      { action: "rebuild", includeStatus: false, limit: 100 },
      { action: "rebuild", includeStatus: false, limit: 100 },
      undefined,
    ]);
    expect(calls[3]).toEqual({ method: "GET", path: "/api/v1/admin/projections/status" });
  });

  test("stops issuing steps once the wall budget is spent and says so", async () => {
    for (let step = 0; step < 5; step += 1) {
      postResponses.push({
        action: "repair",
        complete: false,
        ok: true,
        processed: 1,
        scheduled: 0,
        target: "track_due_work",
      });
    }
    let clock = 0;

    const result = await projections.advanceProjectionCommand({
      action: "repair",
      includeTerminalStatus: false,
      limit: 500,
      maxSteps: 100,
      now: () => {
        const reading = clock;
        clock += 4_000;
        return reading;
      },
      target: "track_due_work",
      wallMs: 10_000,
    });

    expect(result).toMatchObject({ complete: false, processed: 3, steps: 3, wallStopped: true });
    expect(calls).toHaveLength(3);
  });

  test("the first step always runs, whatever the budget, and completion beats the budget", async () => {
    postResponses.push({
      action: "repair",
      complete: true,
      ok: true,
      processed: 4,
      scheduled: 0,
      target: "track_due_work",
    });

    const result = await projections.advanceProjectionCommand({
      action: "repair",
      includeTerminalStatus: false,
      limit: 500,
      maxSteps: 100,
      now: () => 10_000_000,
      target: "track_due_work",
      wallMs: 1_000,
    });

    expect(result).toMatchObject({ complete: true, processed: 4, steps: 1, wallStopped: false });
    expect(calls).toHaveLength(1);
  });

  test("rejects a wall budget outside the supported range", () => {
    expect(() => projections.parseProjectionWallMs("30000")).not.toThrow();
    expect(() => projections.parseProjectionWallMs("999")).toThrow(/--wall-ms/);
    expect(() => projections.parseProjectionWallMs("600001")).toThrow(/--wall-ms/);
    expect(() => projections.parseProjectionWallMs("30_000")).toThrow(/--wall-ms/);
  });

  test("lets repair automation omit the terminal global status read", async () => {
    postResponses.push({
      action: "repair",
      complete: true,
      ok: true,
      processed: 3,
      scheduled: 2,
      status,
      target: "track_due_work",
    });

    const result = await projections.advanceProjectionCommand({
      action: "repair",
      includeTerminalStatus: false,
      limit: 500,
      maxSteps: 20,
      target: "track_due_work",
    });

    expect(result).toEqual({
      action: "repair",
      complete: true,
      ok: true,
      processed: 3,
      scheduled: 2,
      steps: 1,
      target: "track_due_work",
      wallStopped: false,
    });
    expect(calls).toEqual([
      {
        body: { action: "repair", includeStatus: false, limit: 500 },
        method: "POST",
        path: "/api/v1/admin/projections/track_due_work/advance",
      },
    ]);
  });

  test("keeps terminal-status omission scoped to repair automation", async () => {
    let thrown: unknown;
    try {
      await projections.advanceProjectionCommand({
        action: "rebuild",
        includeTerminalStatus: false,
        limit: 500,
        maxSteps: 20,
        target: "track_due_work",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected repair automation guard to throw an Error");
    }
    expect(thrown.message).toMatch(/only for repair automation/);
    expect(calls).toEqual([]);
  });

  test("stops at the first API error without retrying", async () => {
    const firstError = new Error("projection API failed");
    postResponses.push(
      {
        action: "repair",
        complete: false,
        ok: true,
        processed: 1,
        scheduled: 1,
        status,
        target: "crawl_due_work",
      },
      firstError,
      {
        action: "repair",
        complete: false,
        ok: true,
        processed: 100,
        scheduled: 100,
        status,
        target: "crawl_due_work",
      },
    );

    let thrown: unknown;
    try {
      await projections.advanceProjectionCommand({
        action: "repair",
        limit: 25,
        maxSteps: 5,
        target: "crawl_due_work",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(firstError);
    expect(calls).toHaveLength(2);
  });

  test("rejects unbounded or invented controls before transport", () => {
    expect(projections.parseProjectionLimit("500")).toBe(500);
    expect(() => projections.parseProjectionLimit("501")).toThrow(/1 through 500/);
    expect(projections.parseProjectionMaxSteps("100")).toBe(100);
    expect(() => projections.parseProjectionMaxSteps("0")).toThrow(/1 through 100/);
    expect(() => projections.parseProjectionMaxSteps("1.5")).toThrow(/whole number/);
    expect(() => projections.parseProjectionMaxSteps("101")).toThrow(/1 through 100/);
    expect(() => projections.parseProjectionMaxSteps("9007199254740992")).toThrow(/whole number/);
    expect(() => projections.parseProjectionTarget("tracks")).toThrow(/must be/);
    expect(() => projections.parseProjectionAction("sql")).toThrow(/audit, rebuild, or repair/);
    expect(() => projections.parseProjectionCutover("public_aggregates")).toThrow(/must be/);
    expect(() => projections.parseProjectionEnabled("yes")).toThrow(/true or false/);
  });

  test("walks re-key pages only while applying, and resumes from the server's cursor", async () => {
    const page = (cursor: string, hasMore: boolean) => ({
      applied: true,
      cursor,
      definitionVersion: "dv1-current",
      hasMore,
      marked: 2,
      matched: 2,
      ok: true,
      remaining: { count: hasMore ? 2 : 0, truncated: false },
      subjectType: "track",
      workKind: "capture-catalogue",
    });
    postResponses.push(page("t-002", true), page("t-004", false));

    const applied = await projections.rekeyDueWorkQueueCommand({
      apply: true,
      cursor: null,
      limit: 2,
      maxPages: 10,
      workKind: "capture-catalogue",
    });

    expect(applied.pages).toBe(2);
    expect(applied.marked).toBe(4);
    expect(applied.cursor).toBe("t-004");
    expect(calls).toEqual([
      {
        body: { apply: true, cursor: null, limit: 2 },
        method: "POST",
        path: "/api/v1/admin/projections/due-work/capture-catalogue/rekey",
      },
      {
        body: { apply: true, cursor: "t-002", limit: 2 },
        method: "POST",
        path: "/api/v1/admin/projections/due-work/capture-catalogue/rekey",
      },
    ]);

    calls.length = 0;
    postResponses.push({ ...page("t-002", true), applied: false, marked: 0 });
    const dryRun = await projections.rekeyDueWorkQueueCommand({
      apply: false,
      cursor: null,
      limit: 2,
      maxPages: 10,
      workKind: "capture-catalogue",
    });

    expect(dryRun.pages).toBe(1);
    expect(dryRun.marked).toBe(0);
    expect(calls).toHaveLength(1);
    expect(projections.dueWorkRekeyLine(dryRun)).toContain("would mark 2");
  });

  test("bounds the re-key page size and page budget", () => {
    expect(projections.parseDueWorkRekeyLimit("500")).toBe(500);
    expect(() => projections.parseDueWorkRekeyLimit("501")).toThrow(/1 through 500/);
    expect(projections.parseDueWorkRekeyMaxPages("200")).toBe(200);
    expect(() => projections.parseDueWorkRekeyMaxPages("201")).toThrow(/1 through 200/);
    expect(() => projections.parseDueWorkRekeyMaxPages("0")).toThrow(/1 through 200/);
  });

  test("prints readiness without leaking digests or raw source coordinates", () => {
    const lines = projections.projectionStatusLines(status);
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("Track due-work: ready; cutover dark");
    expect(lines.join("\n")).not.toContain("bbbbbbbb");
  });
});
