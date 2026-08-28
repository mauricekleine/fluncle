import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

const calls: { body?: unknown; method: string; path: string }[] = [];
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
        body: { action: "repair", limit: 25, target: "crawl_due_work" },
        method: "POST",
        path: "/api/v1/admin/projections/advance",
      },
      {
        body: { enabled: false, target: "public_projections" },
        method: "PUT",
        path: "/api/v1/admin/projections/cutover",
      },
    ]);
  });

  test("rejects unbounded or invented controls before transport", () => {
    expect(projections.parseProjectionLimit("100")).toBe(100);
    expect(() => projections.parseProjectionLimit("101")).toThrow(/1 through 100/);
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
