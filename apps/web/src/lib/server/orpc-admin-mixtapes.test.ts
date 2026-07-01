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
const setMixtapeCue = vi.fn();
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
  setMixtapeCue: (...args: unknown[]) => setMixtapeCue(...args),
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

const getYouTubeAccessToken = vi.fn();

vi.mock("./youtube", () => ({
  getYouTubeAccessToken: (...args: unknown[]) => getYouTubeAccessToken(...args),
}));

const getMixcloudAccessToken = vi.fn();

vi.mock("./mixcloud", () => ({
  getMixcloudAccessToken: (...args: unknown[]) => getMixcloudAccessToken(...args),
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
  getYouTubeAccessToken.mockReset();
  getMixcloudAccessToken.mockReset();
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

// ── resync_mixtape_youtube — operator tier + description regeneration ─────────
describe("oRPC resync_mixtape_youtube (POST .../youtube/resync)", () => {
  it("403s the AGENT (edits live published content)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/youtube/resync`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(403);
    expect(listMixtapeSocialPosts).not.toHaveBeenCalled();
  });

  it("409s `youtube_not_distributed` when no youtube row exists", async () => {
    listMixtapeSocialPosts.mockResolvedValueOnce([]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/youtube/resync`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(409);
    expect(((await readJson(response)) as { code: string }).code).toBe("youtube_not_distributed");
  });

  it("re-derives the description from the CURRENT cues + preserves the rest of the snippet", async () => {
    listMixtapeSocialPosts.mockResolvedValueOnce([
      {
        createdAt: "t",
        externalId: "vid-1",
        platform: "youtube",
        status: "published",
        updatedAt: "t",
        url: "https://youtu.be/vid-1",
      },
    ]);
    getMixtapeById.mockResolvedValueOnce({
      ...MIXTAPE,
      logId: "019.F.1A",
      members: [
        { artists: ["A"], startMs: 0, title: "One" },
        { artists: ["B"], startMs: 60_000, title: "Two" },
        { artists: ["C"], startMs: 120_000, title: "Three" },
      ],
      note: "a dream",
      status: "published",
    });
    getYouTubeAccessToken.mockResolvedValueOnce("ya29-token");

    let updateBody: { id?: string; snippet?: Record<string, unknown> } = {};
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init?: RequestInit) => {
        if (init?.method === "PUT") {
          updateBody = JSON.parse(typeof init.body === "string" ? init.body : "{}");

          return new Response("{}", { status: 200 });
        }

        // videos.list — return the current snippet (title + categoryId must survive).
        return new Response(
          JSON.stringify({
            items: [
              { snippet: { categoryId: "10", description: "stale text", title: "Set title" } },
            ],
          }),
          { status: 200 },
        );
      });

    try {
      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        req(`/admin/mixtapes/${MIXTAPE_ID}/youtube/resync`, "POST", OPERATOR_TOKEN),
      );

      expect(response?.status).toBe(200);
      expect(await readJson(response)).toEqual({
        ok: true,
        url: "https://youtu.be/vid-1",
        videoId: "vid-1",
      });

      // The update targets the right video and keeps the whole snippet, swapping only
      // the description for the freshly-derived prose + breadcrumb + chapter block.
      expect(updateBody.id).toBe("vid-1");
      expect(updateBody.snippet?.title).toBe("Set title");
      expect(updateBody.snippet?.categoryId).toBe("10");
      expect(updateBody.snippet?.description).toBe(
        "a dream\n\nfluncle://019.F.1A\n\n0:00 A - One\n1:00 B - Two\n2:00 C - Three",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── resync_mixtape_mixcloud — operator tier + section-only edit ───────────────
describe("oRPC resync_mixtape_mixcloud (POST .../mixcloud/resync)", () => {
  it("403s the AGENT (edits live published content)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/mixcloud/resync`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(403);
    expect(listMixtapeSocialPosts).not.toHaveBeenCalled();
  });

  it("409s `mixcloud_not_distributed` when no mixcloud row exists", async () => {
    listMixtapeSocialPosts.mockResolvedValueOnce([]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/mixcloud/resync`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(409);
    expect(((await readJson(response)) as { code: string }).code).toBe("mixcloud_not_distributed");
  });

  it("409s `mixcloud_no_cues` when the mixtape has no cued members", async () => {
    listMixtapeSocialPosts.mockResolvedValueOnce([
      {
        createdAt: "t",
        externalId: "/fluncle/a-set/",
        platform: "mixcloud",
        status: "published",
        updatedAt: "t",
        url: "https://www.mixcloud.com/fluncle/a-set/",
      },
    ]);
    getMixtapeById.mockResolvedValueOnce({
      ...MIXTAPE,
      logId: "019.F.1A",
      members: [{ artists: ["A"], title: "Uncued" }],
      status: "published",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/mixcloud/resync`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(409);
    expect(((await readJson(response)) as { code: string }).code).toBe("mixcloud_no_cues");
  });

  it("pushes ONLY the section fields from the CURRENT cues to the edit endpoint", async () => {
    listMixtapeSocialPosts.mockResolvedValueOnce([
      {
        createdAt: "t",
        externalId: "/fluncle/a-set/",
        platform: "mixcloud",
        status: "published",
        updatedAt: "t",
        url: "https://www.mixcloud.com/fluncle/a-set/",
      },
    ]);
    getMixtapeById.mockResolvedValueOnce({
      ...MIXTAPE,
      logId: "019.F.1A",
      members: [
        { artists: ["A"], startMs: 0, title: "One" },
        { artists: ["B", "C"], startMs: 90_000, title: "Two" },
        { artists: ["D"], title: "Uncued" },
      ],
      status: "published",
    });
    getMixcloudAccessToken.mockResolvedValueOnce("mc-token");

    let editUrl = "";
    let postedFields: [string, string][] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init?: RequestInit) => {
        editUrl = typeof input === "string" ? input : input instanceof URL ? input.href : "";
        const body = init?.body;

        if (body instanceof FormData) {
          postedFields = [...body.entries()].map(([name, value]) => [name, String(value)]);
        }

        return new Response(JSON.stringify({ result: { success: true } }), { status: 200 });
      });

    try {
      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        req(`/admin/mixtapes/${MIXTAPE_ID}/mixcloud/resync`, "POST", OPERATOR_TOKEN),
      );

      expect(response?.status).toBe(200);
      expect(await readJson(response)).toEqual({
        ok: true,
        url: "https://www.mixcloud.com/fluncle/a-set/",
      });

      // The edit endpoint URL carries the token as a query param (Mixcloud diverges
      // from Bearer auth) and splices `edit/` after the cloudcast key.
      expect(editUrl).toContain(
        "https://api.mixcloud.com/upload/fluncle/a-set/edit/?access_token=mc-token",
      );

      // ONLY the section fields are posted (no mp3/name/description) — the cued members
      // in play order, un-cued members omitted, ms → integer seconds, artists joined.
      expect(postedFields).toEqual([
        ["sections-0-artist", "A"],
        ["sections-0-song", "One"],
        ["sections-0-start_time", "0"],
        ["sections-1-artist", "B, C"],
        ["sections-1-song", "Two"],
        ["sections-1-start_time", "90"],
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
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

// create_clip is now recording-scoped (RFC recording-primitive, Design B).
describe("oRPC create_clip (POST /admin/recordings/{recordingId}/clips)", () => {
  const RECORDING_ID = "rec-1";

  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/recordings/${RECORDING_ID}/clips`, "POST", AGENT_TOKEN, {
        inMs: 0,
        outMs: 30_000,
      }),
    );

    expect(response?.status).toBe(403);
    expect(createClip).not.toHaveBeenCalled();
  });

  it("creates for the operator and returns `{ clip, ok }`", async () => {
    createClip.mockResolvedValueOnce(CLIP);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/recordings/${RECORDING_ID}/clips`, "POST", OPERATOR_TOKEN, {
        inMs: 0,
        outMs: 30_000,
        xOffset: 240,
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ clip: CLIP, ok: true });
    expect(createClip).toHaveBeenCalledWith(RECORDING_ID, { inMs: 0, outMs: 30_000, xOffset: 240 });
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

describe("oRPC update_mixtape_cue (PUT /admin/mixtapes/{mixtapeId}/cues/{ref})", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/cues/t1`, "PUT", AGENT_TOKEN, { startMs: 0 }),
    );

    expect(response?.status).toBe(403);
    expect(setMixtapeCue).not.toHaveBeenCalled();
  });

  it("sets one cue for the operator (ref off the path, startMs forwarded)", async () => {
    setMixtapeCue.mockResolvedValueOnce({ ...MIXTAPE, status: "published" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/cues/t2`, "PUT", OPERATOR_TOKEN, { startMs: 180_000 }),
    );

    expect(response?.status).toBe(200);
    expect(setMixtapeCue).toHaveBeenCalledWith(MIXTAPE_ID, { ref: "t2", startMs: 180_000 });
  });

  it("clears a cue when startMs is null", async () => {
    setMixtapeCue.mockResolvedValueOnce({ ...MIXTAPE, status: "published" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/mixtapes/${MIXTAPE_ID}/cues/t2`, "PUT", OPERATOR_TOKEN, { startMs: null }),
    );

    expect(response?.status).toBe(200);
    expect(setMixtapeCue).toHaveBeenCalledWith(MIXTAPE_ID, { ref: "t2", startMs: null });
  });
});
