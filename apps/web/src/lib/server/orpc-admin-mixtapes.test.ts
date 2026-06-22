import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// The admin wave's `admin-mixtapes` parity + auth proof, driven end-to-end
// through `handleOrpc`. Covers the auth tiers (reads = admin; everything else =
// operator), the members POST(append)/PUT(replace) method split on one path, and
// the distribution-step validation (mixcloud `url`, youtube `not_distributed`).
//
//   - list_mixtapes_admin / get_mixtape_social — admin tier (live `requireAdmin`).
//   - create/update/delete/members/publish + every distribution step — operator
//     tier (live `requireOperator`): the agent is a 403.

const listMixtapes = vi.fn();
const createMixtape = vi.fn();
const updateMixtape = vi.fn();
const deleteMixtape = vi.fn();
const addTracksToMixtape = vi.fn();
const setMixtapeMembers = vi.fn();
const publishMixtape = vi.fn();
const getMixtapeById = vi.fn();
const listMixtapeSocialPosts = vi.fn();
const finalizeMixtapeDistribution = vi.fn();

vi.mock("./mixtapes", () => ({
  addTracksToMixtape: (...args: unknown[]) => addTracksToMixtape(...args),
  createMixtape: (...args: unknown[]) => createMixtape(...args),
  deleteMixtape: (...args: unknown[]) => deleteMixtape(...args),
  getMixtapeById: (...args: unknown[]) => getMixtapeById(...args),
  listMixtapes: (...args: unknown[]) => listMixtapes(...args),
  publishMixtape: (...args: unknown[]) => publishMixtape(...args),
  setMixtapeMembers: (...args: unknown[]) => setMixtapeMembers(...args),
  updateMixtape: (...args: unknown[]) => updateMixtape(...args),
}));

vi.mock("./mixtape-social", () => ({
  finalizeMixtapeDistribution: (...args: unknown[]) => finalizeMixtapeDistribution(...args),
  listMixtapeSocialPosts: (...args: unknown[]) => listMixtapeSocialPosts(...args),
}));

const MIXTAPE_ID = "mix-123";

const MIXTAPE = {
  artists: ["Fluncle"] as ["Fluncle"],
  externalUrls: {},
  memberCount: 0,
  members: [],
  status: "draft",
  title: "Mixtape #1",
  type: "mixtape",
};

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  listMixtapes.mockReset();
  createMixtape.mockReset();
  updateMixtape.mockReset();
  deleteMixtape.mockReset();
  addTracksToMixtape.mockReset();
  setMixtapeMembers.mockReset();
  publishMixtape.mockReset();
  getMixtapeById.mockReset();
  listMixtapeSocialPosts.mockReset();
  finalizeMixtapeDistribution.mockReset();
});

// ── list_mixtapes_admin — admin tier ─────────────────────────────────────────
describe("oRPC list_mixtapes_admin (GET /admin/mixtapes)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    expect((await handleOrpc(req("/admin/mixtapes", "GET", undefined)))?.status).toBe(401);
  });

  it("lets the AGENT read (hydrated, including drafts)", async () => {
    listMixtapes.mockResolvedValueOnce([MIXTAPE]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/mixtapes", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ mixtapes: [MIXTAPE], ok: true });
    expect(listMixtapes).toHaveBeenCalledWith({ hydrateMembers: true, includeDrafts: true });
  });
});

// ── create_mixtape — operator tier ───────────────────────────────────────────
describe("oRPC create_mixtape (POST /admin/mixtapes)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/mixtapes", "POST", AGENT_TOKEN, { note: "x" }));

    expect(response?.status).toBe(403);
    expect(createMixtape).not.toHaveBeenCalled();
  });

  it("creates for the operator and returns the live envelope", async () => {
    createMixtape.mockResolvedValueOnce(MIXTAPE);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/mixtapes", "POST", OPERATOR_TOKEN, { note: "a dream" }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ mixtape: MIXTAPE, ok: true });
    expect(createMixtape).toHaveBeenCalledWith({ note: "a dream" });
  });
});

// ── members: POST appends, PUT replaces (one path, two ops) ──────────────────
describe("oRPC mixtape members (POST append / PUT replace)", () => {
  it("403s the AGENT on POST append", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/members`, "POST", AGENT_TOKEN, { members: [] }),
    );

    expect(response?.status).toBe(403);
    expect(addTracksToMixtape).not.toHaveBeenCalled();
  });

  it("APPENDS for the operator on POST", async () => {
    addTracksToMixtape.mockResolvedValueOnce(MIXTAPE);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/members`, "POST", OPERATOR_TOKEN, {
        members: [{ trackId: "t1" }],
      }),
    );

    expect(response?.status).toBe(200);
    expect(addTracksToMixtape).toHaveBeenCalledWith(MIXTAPE_ID, { members: [{ trackId: "t1" }] });
    expect(setMixtapeMembers).not.toHaveBeenCalled();
  });

  it("REPLACES for the operator on PUT", async () => {
    setMixtapeMembers.mockResolvedValueOnce(MIXTAPE);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/members`, "PUT", OPERATOR_TOKEN, {
        members: [{ trackId: "t2" }],
      }),
    );

    expect(response?.status).toBe(200);
    expect(setMixtapeMembers).toHaveBeenCalledWith(MIXTAPE_ID, { members: [{ trackId: "t2" }] });
    expect(addTracksToMixtape).not.toHaveBeenCalled();
  });
});

// ── delete_mixtape — operator tier ───────────────────────────────────────────
describe("oRPC delete_mixtape (DELETE /admin/mixtapes/{mixtapeId})", () => {
  it("403s the AGENT", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/mixtapes/${MIXTAPE_ID}`, "DELETE", AGENT_TOKEN));

    expect(response?.status).toBe(403);
    expect(deleteMixtape).not.toHaveBeenCalled();
  });

  it("deletes for the operator and returns `{ ok: true }`", async () => {
    deleteMixtape.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}`, "DELETE", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(deleteMixtape).toHaveBeenCalledWith(MIXTAPE_ID);
  });
});

// ── publish_mixtape — operator tier ──────────────────────────────────────────
describe("oRPC publish_mixtape (POST .../publish)", () => {
  it("403s the AGENT", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/publish`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(403);
    expect(publishMixtape).not.toHaveBeenCalled();
  });

  it("mints for the operator (bodyless POST)", async () => {
    publishMixtape.mockResolvedValueOnce({ ...MIXTAPE, status: "distributing" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/publish`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(publishMixtape).toHaveBeenCalledWith(MIXTAPE_ID);
  });
});

// ── get_mixtape_social — admin tier ──────────────────────────────────────────
describe("oRPC get_mixtape_social (GET .../social)", () => {
  it("lets the AGENT read", async () => {
    listMixtapeSocialPosts.mockResolvedValueOnce([
      { createdAt: "t", platform: "youtube", status: "published", updatedAt: "t" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/social`, "GET", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      mixtapeId: MIXTAPE_ID,
      ok: true,
      posts: [{ createdAt: "t", platform: "youtube", status: "published", updatedAt: "t" }],
    });
  });
});

// ── finalize_mixtape_mixcloud — operator tier + url validation ───────────────
describe("oRPC finalize_mixtape_mixcloud (POST .../mixcloud/finalize)", () => {
  it("403s the AGENT", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/mixcloud/finalize`, "POST", AGENT_TOKEN, {
        url: "https://mixcloud.com/x",
      }),
    );

    expect(response?.status).toBe(403);
    expect(finalizeMixtapeDistribution).not.toHaveBeenCalled();
  });

  it("400s `invalid_request` for a missing url", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/mixcloud/finalize`, "POST", OPERATOR_TOKEN, {}),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("invalid_request");
  });

  it("records the cloudcast for the operator and returns the live envelope", async () => {
    finalizeMixtapeDistribution.mockResolvedValueOnce({ ...MIXTAPE, status: "published" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/mixcloud/finalize`, "POST", OPERATOR_TOKEN, {
        externalId: "cc-1",
        url: "https://mixcloud.com/x",
      }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { ok: boolean; platform: string };
    expect(data.ok).toBe(true);
    expect(data.platform).toBe("mixcloud");
    expect(finalizeMixtapeDistribution).toHaveBeenCalledWith(MIXTAPE_ID, "mixcloud", {
      externalId: "cc-1",
      url: "https://mixcloud.com/x",
    });
  });
});

// ── publish_mixtape_youtube — operator tier + distribution gate ──────────────
describe("oRPC publish_mixtape_youtube (POST .../youtube/publish)", () => {
  it("403s the AGENT", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/youtube/publish`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(403);
    expect(listMixtapeSocialPosts).not.toHaveBeenCalled();
  });

  it("409s `youtube_not_distributed` when no youtube row exists", async () => {
    listMixtapeSocialPosts.mockResolvedValueOnce([]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/youtube/publish`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(409);
    expect(((await readJson(response)) as { code: string }).code).toBe("youtube_not_distributed");
  });
});
