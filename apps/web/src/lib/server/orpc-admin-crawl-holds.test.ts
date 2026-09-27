import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const listMock = vi.fn();
const resolveMock = vi.fn();

vi.mock("./crawl-plausibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crawl-plausibility")>();

  return {
    ...actual,
    listCrawlHolds: (...args: unknown[]) => listMock(...args),
    resolveCrawlHold: (...args: unknown[]) => resolveMock(...args),
  };
});

const HOLD = {
  artists: ["Easy Listening Orchestra"],
  createdAt: "2026-09-27T00:00:00.000Z",
  labelId: "lbl_mta",
  labelName: "MTA Records",
  labelSlug: "mta-records",
  reason: "before_founding",
  releaseDate: "1969",
  releaseMbid: "7c0bb2a5-6f5a-4f09-9a3c-2c6f8f7f1a11",
  releaseTitle: "Just Some Of Those Songs",
  state: "held",
  thresholdYear: 2009,
  trackCount: 12,
};

const RESOLVE_PATH = `/admin/catalogue/holds/${HOLD.releaseMbid}/resolve`;

beforeAll(() => {
  setAdminTokenEnv();
});

warmOrpcRouter();

beforeEach(() => {
  listMock.mockReset();
  resolveMock.mockReset();
  listMock.mockResolvedValue({ holds: [HOLD], total: 1 });
  resolveMock.mockResolvedValue({ state: "released" });
});

describe("oRPC list_crawl_holds (GET /admin/catalogue/holds)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/catalogue/holds", "GET", undefined));

    expect(response?.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("answers the agent token with the held queue and coerces the query limit", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/catalogue/holds?limit=5&state=kept_out", "GET", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ holds: [HOLD], ok: true, total: 1 });
    expect(listMock).toHaveBeenCalledWith({ limit: 5, state: "kept_out" });
  });
});

describe("oRPC resolve_crawl_hold (POST /admin/catalogue/holds/{releaseMbid}/resolve)", () => {
  it("403s the agent token: ruling a hold is operator-tier", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(RESOLVE_PATH, "POST", AGENT_TOKEN, { decision: "store" }),
    );

    expect(response?.status).toBe(403);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("merges the path release id with the body decision for the operator", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(RESOLVE_PATH, "POST", OPERATOR_TOKEN, { decision: "store" }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, state: "released" });
    expect(resolveMock).toHaveBeenCalledWith(HOLD.releaseMbid, "store");
  });

  it("rejects a decision outside store and keep_out", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(RESOLVE_PATH, "POST", OPERATOR_TOKEN, { decision: "delete" }),
    );

    expect(response?.status).toBe(400);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("maps an unknown hold to 404 and an already-released one to 409", async () => {
    const { CrawlHoldAlreadyReleasedError, CrawlHoldNotFoundError } =
      await import("./crawl-plausibility");
    const { handleOrpc } = await import("./orpc");

    resolveMock.mockRejectedValueOnce(new CrawlHoldNotFoundError(HOLD.releaseMbid));
    const missing = await handleOrpc(
      req(RESOLVE_PATH, "POST", OPERATOR_TOKEN, { decision: "keep_out" }),
    );
    expect(missing?.status).toBe(404);

    resolveMock.mockRejectedValueOnce(new CrawlHoldAlreadyReleasedError(HOLD.releaseMbid));
    const released = await handleOrpc(
      req(RESOLVE_PATH, "POST", OPERATOR_TOKEN, { decision: "keep_out" }),
    );
    expect(released?.status).toBe(409);
  });
});
