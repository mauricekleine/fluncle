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
        status,
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
    expect(calls).toHaveLength(1);
  });

  test("aggregates exhausted steps and preserves the final payload", async () => {
    const finalStatus = { ...status, readyToOpen: { ...status.readyToOpen, publicProjections: false } };
    postResponses.push(
      {
        action: "rebuild",
        complete: false,
        ok: true,
        processed: 2,
        scheduled: 3,
        status,
        target: "track_due_work",
      },
      {
        action: "rebuild",
        complete: false,
        ok: true,
        processed: 5,
        scheduled: 7,
        status,
        target: "track_due_work",
      },
      {
        action: "rebuild",
        complete: false,
        ok: true,
        processed: 11,
        scheduled: 13,
        status: finalStatus,
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
      status: finalStatus,
      steps: 3,
      target: "track_due_work",
    });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.body)).toEqual([
      { action: "rebuild", limit: 100 },
      { action: "rebuild", limit: 100 },
      { action: "rebuild", limit: 100 },
    ]);
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

    await expect(
      projections.advanceProjectionCommand({
        action: "repair",
        limit: 25,
        maxSteps: 5,
        target: "crawl_due_work",
      }),
    ).rejects.toBe(firstError);
    expect(calls).toHaveLength(2);
  });

  test("rejects unbounded or invented controls before transport", () => {
    expect(projections.parseProjectionLimit("500")).toBe(500);
    expect(() => projections.parseProjectionLimit("501")).toThrow(/1 through 500/);
    expect(projections.parseProjectionMaxSteps("100")).toBe(100);
    expect(() => projections.parseProjectionMaxSteps("0")).toThrow(/1 through 100/);
    expect(() => projections.parseProjectionMaxSteps("1.5")).toThrow(/safe integer/);
    expect(() => projections.parseProjectionMaxSteps("101")).toThrow(/1 through 100/);
    expect(() => projections.parseProjectionMaxSteps("9007199254740992")).toThrow(
      /safe integer/,
    );
    expect(() => projections.parseProjectionTarget("tracks")).toThrow(/must be/);
    expect(() => projections.parseProjectionAction("sql")).toThrow(/audit, rebuild, or repair/);
    expect(() => projections.parseProjectionCutover("public_aggregates")).toThrow(/must be/);
    expect(() => projections.parseProjectionEnabled("yes")).toThrow(/true or false/);
  });

  test("prints readiness without leaking digests or raw source coordinates", () => {
    const lines = projections.projectionStatusLines(status);
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("Track due-work: ready; cutover dark");
    expect(lines.join("\n")).not.toContain("bbbbbbbb");
  });
});
