import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexNowFailed } from "./indexnow";
import { AGENT_TOKEN, readJson, req, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const catalogue = vi.hoisted(() => ({
  submitIndexNowCatalogue: vi.fn(),
  walkIndexNowCatalogue: vi.fn(),
}));
vi.mock("./indexnow-catalogue", () => catalogue);
beforeAll(setAdminTokenEnv);
warmOrpcRouter();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network call")));
});

const PATH = "/admin/indexnow/submit";

describe("submit_indexnow transport and agent authority", () => {
  it("lets the agent walk the cursor-bound catalogue window", async () => {
    catalogue.walkIndexNowCatalogue.mockResolvedValue({
      changed: 2,
      checked: 250,
      inserted: 3,
      kind: "artist",
      next: { after: "artist-a", kind: "artist" },
      removed: 4,
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, {
        cursor: { after: "artist-0", kind: "artist" },
        phase: "walk",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      checked: 250,
      next: { after: "artist-a", kind: "artist" },
      ok: true,
      phase: "walk",
      removed: 4,
    });
    expect(catalogue.walkIndexNowCatalogue).toHaveBeenCalledWith({
      after: "artist-0",
      kind: "artist",
    });
  });

  it("passes the dry-run flag to the submission boundary", async () => {
    catalogue.submitIndexNowCatalogue.mockResolvedValue({
      dryRun: true,
      due: 12,
      sample: ["https://www.fluncle.com/log/001.1.1A"],
      status: null,
      submitted: 12,
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(PATH, "POST", AGENT_TOKEN, { dryRun: true, phase: "submit" }),
    );
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      dryRun: true,
      due: 12,
      ok: true,
      phase: "submit",
      status: null,
      submitted: 12,
    });
    expect(catalogue.submitIndexNowCatalogue).toHaveBeenCalledWith(true);
  });

  it("carries a rejected upstream status and queue count to the box without acknowledging submission", async () => {
    catalogue.submitIndexNowCatalogue.mockRejectedValue(
      new IndexNowFailed({
        cause: "IndexNow HTTP 429: slow down",
        due: 12,
        excerpt: "slow down",
        status: 429,
      }),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "POST", AGENT_TOKEN, { phase: "submit" }));
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      due: 12,
      error: "IndexNow HTTP 429: slow down",
      ok: false,
      phase: "submit",
      status: 429,
      submitted: 0,
    });
  });

  it("preserves accepted URLs and their upstream status when the ledger stamp fails", async () => {
    catalogue.submitIndexNowCatalogue.mockRejectedValue(
      new IndexNowFailed({
        cause: "Could not stamp accepted page versions",
        status: 202,
        submitted: 5,
      }),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "POST", AGENT_TOKEN, { phase: "submit" }));
    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      due: null,
      error: "Could not stamp accepted page versions",
      ok: false,
      phase: "submit",
      status: 202,
      submitted: 5,
    });
  });

  it("refuses anonymous calls before catalogue work starts", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(PATH, "POST", undefined, { phase: "submit" }));
    expect(response?.status).toBe(401);
    expect(catalogue.submitIndexNowCatalogue).not.toHaveBeenCalled();
  });

  it("refuses invalid kinds and empty keys at the contract boundary", async () => {
    const { handleOrpc } = await import("./orpc");
    for (const cursor of [{ kind: "galaxy" }, { after: "", kind: "track" }]) {
      const response = await handleOrpc(req(PATH, "POST", AGENT_TOKEN, { cursor, phase: "walk" }));
      expect(response?.status).toBe(400);
    }
    expect(catalogue.walkIndexNowCatalogue).not.toHaveBeenCalled();
  });
});
