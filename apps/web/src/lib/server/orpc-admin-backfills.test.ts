import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "./orpc-test-helpers";
import { warmOrpcRouter } from "./orpc-test-kit";

const backfillDiscogsIds = vi.fn();
const backfillLastfmLoves = vi.fn();

vi.mock("./backfill", () => ({
  backfillDiscogsIds: (...args: unknown[]) => backfillDiscogsIds(...args),
  backfillLastfmLoves: (...args: unknown[]) => backfillLastfmLoves(...args),
}));

const OPERATOR_TOKEN = "test-token-admin-operator";
const AGENT_TOKEN = "test-token-admin-agent";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
});

warmOrpcRouter();

beforeEach(() => {
  backfillDiscogsIds.mockReset();
  backfillLastfmLoves.mockReset();
});

function post(path: string, token: string | undefined): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(`https://www.fluncle.com/api/v1${path}`, { headers, method: "POST" });
}

describe("oRPC backfill_discogs (POST /admin/backfill/discogs)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/discogs", undefined));

    expect(response?.status).toBe(401);
    expect(backfillDiscogsIds).not.toHaveBeenCalled();
  });

  it("allows the AGENT (agent tier — the box cron drives it)", async () => {
    backfillDiscogsIds.mockResolvedValueOnce({
      dryRun: false,
      nextCursor: null,
      rateLimited: false,
      rateLimitedBy: null,
      resolved: [],
      resolvedCount: 0,
      skipped: [],
      skippedCount: 0,
      unresolved: [],
      unresolvedCount: 0,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/discogs", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(backfillDiscogsIds).toHaveBeenCalled();
  });

  it("runs a pass for the operator and returns the live envelope", async () => {
    backfillDiscogsIds.mockResolvedValueOnce({
      dryRun: false,
      nextCursor: "cur-2",
      rateLimited: false,
      rateLimitedBy: null,
      resolved: [{ logId: "004.7.2I", releaseId: 12, source: "discogs" }],
      resolvedCount: 1,
      skipped: ["004.7.4K"],
      skippedCount: 1,
      unresolved: ["004.7.3J"],
      unresolvedCount: 1,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/admin/backfill/discogs?limit=10&dryRun=1&cursor=cur-1", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      discogsWork: [],
      dryRun: false,
      nextCursor: "cur-2",
      ok: true,
      rateLimited: false,
      rateLimitedBy: null,
      resolved: [{ logId: "004.7.2I", releaseId: 12, source: "discogs" }],
      resolvedCount: 1,
      skipped: ["004.7.4K"],
      skippedCount: 1,
      unresolved: ["004.7.3J"],
      unresolvedCount: 1,
    });

    expect(backfillDiscogsIds).toHaveBeenCalledWith(10, true, "cur-1", {
      boxFetch: false,
      discogsCandidates: undefined,
    });
  });
});

describe("oRPC backfill_lastfm (POST /admin/backfill/lastfm)", () => {
  it("allows the AGENT (agent tier — the box cron drives it)", async () => {
    backfillLastfmLoves.mockResolvedValueOnce({
      dryRun: false,
      failed: [],
      failedCount: 0,
      loved: [],
      lovedCount: 0,
      nextCursor: null,
      rateLimited: false,
      skipped: [],
      skippedCount: 0,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/lastfm", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(backfillLastfmLoves).toHaveBeenCalled();
  });

  it("runs a pass for the operator and returns the live envelope", async () => {
    backfillLastfmLoves.mockResolvedValueOnce({
      dryRun: true,
      failed: [{ error: "boom", logId: "004.7.3J" }],
      failedCount: 1,
      loved: ["004.7.2I"],
      lovedCount: 1,
      nextCursor: null,
      rateLimited: false,
      skipped: ["004.7.4K"],
      skippedCount: 1,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/admin/backfill/lastfm?dryRun=true", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      dryRun: true,
      failed: [{ error: "boom", logId: "004.7.3J" }],
      failedCount: 1,
      loved: ["004.7.2I"],
      lovedCount: 1,
      nextCursor: null,
      ok: true,
      rateLimited: false,
      skipped: ["004.7.4K"],
      skippedCount: 1,
    });

    expect(backfillLastfmLoves).toHaveBeenCalledWith(50, true, undefined);
  });
});
