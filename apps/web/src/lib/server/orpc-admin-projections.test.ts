import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const getProjectionStatusFor = vi.fn();
const advanceProjectionFor = vi.fn();
const setProjectionCutoverFor = vi.fn();

vi.mock("./db", () => ({ getDb: async () => ({}) }));
vi.mock("./projection-operations", () => ({
  advanceProjectionFor: (...args: unknown[]) => advanceProjectionFor(...args),
  getProjectionStatusFor: (...args: unknown[]) => getProjectionStatusFor(...args),
  setProjectionCutoverFor: (...args: unknown[]) => setProjectionCutoverFor(...args),
}));

const count = { count: 0, truncated: false };
const family = {
  backlog: { leased: count, ready: count, scheduled: count },
  convergence: {
    digestMatched: true,
    epochMatched: true,
    projectedDigest: "0".repeat(64),
    projectedEpoch: 0,
    sourceDigest: "0".repeat(64),
    sourceEpoch: 0,
  },
  ready: true,
  rebuild: { complete: true, completed: 1, projected: 0, running: 0, scanned: 0, total: 1 },
  repairs: { direct: count, fanout: count, total: count },
};
const STATUS = {
  cutovers: { crawlDueWork: false, publicProjections: true, trackDueWork: false },
  projections: {
    artistQualification: family,
    crawlDueWork: family,
    publicAggregates: { ...family, anchorsReady: true },
    trackDueWork: family,
  },
  readyToOpen: { crawlDueWork: true, publicProjections: true, trackDueWork: true },
};

beforeAll(setAdminTokenEnv);
warmOrpcRouter();

beforeEach(() => {
  getProjectionStatusFor.mockReset().mockResolvedValue(STATUS);
  advanceProjectionFor.mockReset().mockResolvedValue({
    complete: true,
    processed: 0,
    scheduled: 0,
    status: STATUS,
  });
  setProjectionCutoverFor.mockReset().mockResolvedValue(STATUS);
});

describe("projection agent authorization", () => {
  it("lets the agent read bounded status", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/projections/status", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(getProjectionStatusFor).toHaveBeenCalledOnce();
  });

  it.each([
    "public_aggregates",
    "artist_qualification",
    "track_due_work",
    "crawl_due_work",
  ] as const)("lets the agent repair only %s", async (target) => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/projections/${target}/advance`, "POST", AGENT_TOKEN, {
        action: "repair",
        limit: 500,
      }),
    );

    expect(response?.status).toBe(200);
    expect(advanceProjectionFor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "repair", limit: 500, target }),
    );
  });

  it.each([
    ["public_aggregates", "rebuild"],
    ["public_aggregates", "audit"],
    ["artist_qualification", "rebuild"],
    ["artist_qualification", "audit"],
    ["track_due_work", "rebuild"],
    ["track_due_work", "audit"],
    ["crawl_due_work", "rebuild"],
    ["crawl_due_work", "audit"],
  ] as const)("403s agent %s/%s before database work", async (target, action) => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/projections/${target}/advance`, "POST", AGENT_TOKEN, {
        action,
        limit: 100,
      }),
    );

    expect(response?.status).toBe(403);
    expect(advanceProjectionFor).not.toHaveBeenCalled();
  });

  it.each(["track_due_work", "crawl_due_work"] as const)(
    "rejects an unbounded agent repair for %s before database work",
    async (target) => {
      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        req(`/admin/projections/${target}/advance`, "POST", AGENT_TOKEN, {
          action: "repair",
          limit: 501,
        }),
      );

      expect(response?.status).toBe(400);
      expect(advanceProjectionFor).not.toHaveBeenCalled();
    },
  );

  it.each(["crawl_due_work", "public_projections", "track_due_work"] as const)(
    "keeps agent cutover mutation forbidden for %s",
    async (target) => {
      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        req(`/admin/projections/${target}/cutover`, "PUT", AGENT_TOKEN, { enabled: false }),
      );

      expect(response?.status).toBe(403);
      expect(setProjectionCutoverFor).not.toHaveBeenCalled();
    },
  );
});

describe("projection operator authorization stays complete", () => {
  it.each([
    ["public_aggregates", "repair"],
    ["public_aggregates", "rebuild"],
    ["public_aggregates", "audit"],
    ["artist_qualification", "repair"],
    ["artist_qualification", "rebuild"],
    ["artist_qualification", "audit"],
    ["track_due_work", "repair"],
    ["track_due_work", "rebuild"],
    ["track_due_work", "audit"],
    ["crawl_due_work", "repair"],
    ["crawl_due_work", "rebuild"],
    ["crawl_due_work", "audit"],
  ] as const)("keeps operator %s/%s allowed", async (target, action) => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/projections/${target}/advance`, "POST", OPERATOR_TOKEN, {
        action,
        limit: 100,
      }),
    );

    expect(response?.status).toBe(200);
    expect(advanceProjectionFor).toHaveBeenCalledOnce();
  });

  it("keeps operator cutover writes allowed", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/projections/public_projections/cutover", "PUT", OPERATOR_TOKEN, {
        enabled: true,
      }),
    );

    expect(response?.status).toBe(200);
    expect(setProjectionCutoverFor).toHaveBeenCalledOnce();
  });

  it("lets bounded multi-step callers defer the status snapshot", async () => {
    advanceProjectionFor.mockResolvedValueOnce({
      complete: false,
      processed: 5,
      scheduled: 5,
      status: undefined,
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/projections/track_due_work/advance", "POST", OPERATOR_TOKEN, {
        action: "repair",
        includeStatus: false,
        limit: 500,
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).not.toHaveProperty("status");
    expect(advanceProjectionFor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "repair",
        includeStatus: false,
        limit: 500,
        target: "track_due_work",
      }),
    );
  });

  it("defaults an omitted status preference to a status-bearing response", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/projections/track_due_work/advance", "POST", OPERATOR_TOKEN, {
        action: "repair",
        limit: 500,
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toHaveProperty("status", STATUS);
    expect(advanceProjectionFor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeStatus: true }),
    );
  });

  it("returns a conflict when a cutover wins the audit-initialization race", async () => {
    advanceProjectionFor.mockRejectedValueOnce(
      new Error("projection audit requires a dark target"),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/projections/track_due_work/advance", "POST", OPERATOR_TOKEN, {
        action: "audit",
        includeStatus: false,
        limit: 500,
      }),
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: "projection_step_conflict" });
  });
});
