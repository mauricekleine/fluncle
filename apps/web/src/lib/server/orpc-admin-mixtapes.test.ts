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
const setMixtapeCues = vi.fn();
const listClips = vi.fn();
const createClip = vi.fn();
const updateClip = vi.fn();
const deleteClip = vi.fn();

vi.mock("./mixtapes", () => ({
  addTracksToMixtape: (...args: unknown[]) => addTracksToMixtape(...args),
  createMixtape: (...args: unknown[]) => createMixtape(...args),
  deleteMixtape: (...args: unknown[]) => deleteMixtape(...args),
  getMixtapeById: (...args: unknown[]) => getMixtapeById(...args),
  listMixtapes: (...args: unknown[]) => listMixtapes(...args),
  publishMixtape: (...args: unknown[]) => publishMixtape(...args),
  setMixtapeCues: (...args: unknown[]) => setMixtapeCues(...args),
  setMixtapeMembers: (...args: unknown[]) => setMixtapeMembers(...args),
  updateMixtape: (...args: unknown[]) => updateMixtape(...args),
}));

vi.mock("./clips", () => ({
  createClip: (...args: unknown[]) => createClip(...args),
  deleteClip: (...args: unknown[]) => deleteClip(...args),
  listClips: (...args: unknown[]) => listClips(...args),
  updateClip: (...args: unknown[]) => updateClip(...args),
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
  setMixtapeCues.mockReset();
  listClips.mockReset();
  createClip.mockReset();
  updateClip.mockReset();
  deleteClip.mockReset();
});

const CLIP = {
  createdAt: "2026-06-29T00:00:00.000Z",
  id: "clip-1",
  inMs: 0,
  mixtapeId: MIXTAPE_ID,
  outMs: 30_000,
  status: "pending" as const,
  updatedAt: "2026-06-29T00:00:00.000Z",
  xOffset: 240,
};

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

// ── Fluncle Studio clips (Unit D): list = admin; create/update/delete = operator ─
describe("oRPC list_clips (GET /admin/clips)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    expect((await handleOrpc(req("/admin/clips", "GET", undefined)))?.status).toBe(401);
  });

  it("lets the AGENT read, passing the ?mixtapeId/?status filters through", async () => {
    listClips.mockResolvedValueOnce([CLIP]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/clips?mixtapeId=${MIXTAPE_ID}&status=pending`, "GET", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ clips: [CLIP], ok: true });
    expect(listClips).toHaveBeenCalledWith({ mixtapeId: MIXTAPE_ID, status: "pending" });
  });
});

describe("oRPC create_clip (POST /admin/mixtapes/{mixtapeId}/clips)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/clips`, "POST", AGENT_TOKEN, { inMs: 0, outMs: 30_000 }),
    );

    expect(response?.status).toBe(403);
    expect(createClip).not.toHaveBeenCalled();
  });

  it("creates for the operator and returns `{ clip, ok }`", async () => {
    createClip.mockResolvedValueOnce(CLIP);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/clips`, "POST", OPERATOR_TOKEN, {
        inMs: 0,
        outMs: 30_000,
        xOffset: 240,
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ clip: CLIP, ok: true });
    expect(createClip).toHaveBeenCalledWith(MIXTAPE_ID, { inMs: 0, outMs: 30_000, xOffset: 240 });
  });
});

describe("oRPC update_clip (PATCH /admin/clips/{clipId})", () => {
  it("403s the AGENT", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/clip-1", "PATCH", AGENT_TOKEN, { caption: "x" }),
    );

    expect(response?.status).toBe(403);
    expect(updateClip).not.toHaveBeenCalled();
  });

  it("updates for the operator (clipId off the path, body forwarded)", async () => {
    updateClip.mockResolvedValueOnce({ ...CLIP, caption: "a banger" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/clip-1", "PATCH", OPERATOR_TOKEN, { caption: "a banger" }),
    );

    expect(response?.status).toBe(200);
    expect(updateClip).toHaveBeenCalledWith("clip-1", { caption: "a banger" });
  });
});

describe("oRPC delete_clip (DELETE /admin/clips/{clipId})", () => {
  it("403s the AGENT", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/clip-1", "DELETE", AGENT_TOKEN));

    expect(response?.status).toBe(403);
    expect(deleteClip).not.toHaveBeenCalled();
  });

  it("deletes for the operator and returns `{ ok: true }`", async () => {
    deleteClip.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/clip-1", "DELETE", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(deleteClip).toHaveBeenCalledWith("clip-1");
  });
});

describe("oRPC set_mixtape_cues (PUT /admin/mixtapes/{mixtapeId}/cues)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/cues`, "PUT", AGENT_TOKEN, { cues: [] }),
    );

    expect(response?.status).toBe(403);
    expect(setMixtapeCues).not.toHaveBeenCalled();
  });

  it("backfills for the operator (mixtapeId off the path, cues forwarded)", async () => {
    setMixtapeCues.mockResolvedValueOnce({ ...MIXTAPE, status: "published" });
    const cues = [
      { ref: "t1", startMs: 0 },
      { ref: "t2", startMs: 180_000 },
    ];

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/cues`, "PUT", OPERATOR_TOKEN, { cues }),
    );

    expect(response?.status).toBe(200);
    expect(setMixtapeCues).toHaveBeenCalledWith(MIXTAPE_ID, { cues });
  });
});
