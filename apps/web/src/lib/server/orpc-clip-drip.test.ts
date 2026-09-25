import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const isDripPaused = vi.fn();
const setDripPaused = vi.fn();
const countRecentPostedInWindow = vi.fn();
const countDueClipPosts = vi.fn();
const dueClipPosts = vi.fn();
const setClipPostStatus = vi.fn();
const upsertClipPost = vi.fn();
const deleteClipPost = vi.fn();
const getClipPost = vi.fn();
const listClipPosts = vi.fn();
const postedClipPostsAwaitingUrl = vi.fn();

vi.mock("./clip-social", () => ({
  CLIP_DRIP_PLATFORM: "instagram",
  countDueClipPosts: (...a: unknown[]) => countDueClipPosts(...a),
  countRecentPostedInWindow: (...a: unknown[]) => countRecentPostedInWindow(...a),
  deleteClipPost: (...a: unknown[]) => deleteClipPost(...a),
  dueClipPosts: (...a: unknown[]) => dueClipPosts(...a),
  getClipPost: (...a: unknown[]) => getClipPost(...a),
  isDripPaused: (...a: unknown[]) => isDripPaused(...a),
  listClipPosts: (...a: unknown[]) => listClipPosts(...a),
  nextDripSlot: async () => "2026-07-06T12:00:00.000Z",
  postedClipPostsAwaitingUrl: (...a: unknown[]) => postedClipPostsAwaitingUrl(...a),
  setClipPostStatus: (...a: unknown[]) => setClipPostStatus(...a),
  setDripPaused: (...a: unknown[]) => setDripPaused(...a),
  upsertClipPost: (...a: unknown[]) => upsertClipPost(...a),
}));

const pushInstagramReel = vi.fn();
const resolveSocialUrl = vi.fn();
const postizSetReleaseId = vi.fn();

vi.mock("./postiz", () => ({
  postizSetReleaseId: (...a: unknown[]) => postizSetReleaseId(...a),
  pushInstagramReel: (...a: unknown[]) => pushInstagramReel(...a),
  resolveSocialUrl: (...a: unknown[]) => resolveSocialUrl(...a),
}));

const buildClipCaption = vi.fn();

vi.mock("./clip-caption", () => ({
  buildClipCaption: (...a: unknown[]) => buildClipCaption(...a),
}));

const getClip = vi.fn();

vi.mock("./clips", () => ({
  createClip: vi.fn(),
  deleteClip: vi.fn(),
  getClip: (...a: unknown[]) => getClip(...a),
  listClips: vi.fn(),
  markClipCutDone: vi.fn(),
  updateClip: vi.fn(),
}));

beforeAll(setAdminTokenEnv);

warmOrpcRouter();

beforeEach(() => {
  vi.clearAllMocks();
  isDripPaused.mockResolvedValue(false);
  countRecentPostedInWindow.mockResolvedValue(0);
  countDueClipPosts.mockResolvedValue(0);
  dueClipPosts.mockResolvedValue([]);

  postedClipPostsAwaitingUrl.mockResolvedValue([]);
  resolveSocialUrl.mockResolvedValue(null);
  postizSetReleaseId.mockResolvedValue(undefined);
  buildClipCaption.mockImplementation(async (clipId: string) => ({
    builtCaption: `caption for ${clipId}`,
    clipId,
    coordinates: [],
  }));
  pushInstagramReel.mockResolvedValue({ postId: "post-x" });
});

describe("oRPC drip_clips (POST /admin/clips/drip)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    expect((await handleOrpc(req("/admin/clips/drip", "POST", undefined, {})))?.status).toBe(401);
  });

  it("no-ops when the kill switch is on (paused: true, nothing posted)", async () => {
    isDripPaused.mockResolvedValue(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      attempted: 0,
      captured: 0,
      failed: 0,
      ok: true,
      paused: true,
      posted: 0,
      skippedBlank: 0,
      skippedCapped: 0,
    });
    expect(dueClipPosts).not.toHaveBeenCalled();
    expect(pushInstagramReel).not.toHaveBeenCalled();
  });

  it("posts the due clips (agent token) and marks each posted", async () => {
    countDueClipPosts.mockResolvedValue(2);
    dueClipPosts.mockResolvedValue([
      { clipId: "clip-1", scheduledFor: "2026-07-05T00:00:00.000Z" },
      { clipId: "clip-2", scheduledFor: "2026-07-05T01:00:00.000Z" },
    ]);
    pushInstagramReel
      .mockResolvedValueOnce({ postId: "p1" })
      .mockResolvedValueOnce({ postId: "p2" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      attempted: 2,
      captured: 0,
      failed: 0,
      ok: true,
      paused: false,
      posted: 2,
      skippedBlank: 0,
      skippedCapped: 0,
    });
    expect(pushInstagramReel).toHaveBeenCalledTimes(2);

    expect(pushInstagramReel).toHaveBeenCalledWith({
      caption: "caption for clip-1",
      videoUrl: "https://found.fluncle.com/clip-1/footage.mp4",
    });
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-1", "posted", { postizId: "p1" });
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-2", "posted", { postizId: "p2" });
  });

  it("clamps the budget to the rolling-24h cap and reports skippedCapped", async () => {
    countRecentPostedInWindow.mockResolvedValue(9);
    countDueClipPosts.mockResolvedValue(5);
    dueClipPosts.mockResolvedValue([
      { clipId: "clip-1", scheduledFor: "2026-07-05T00:00:00.000Z" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(dueClipPosts).toHaveBeenCalledWith({ limit: 1 });
    expect(await readJson(response)).toEqual({
      attempted: 1,
      captured: 0,
      failed: 0,
      ok: true,
      paused: false,
      posted: 1,
      skippedBlank: 0,
      skippedCapped: 4,
    });
  });

  it("marks a failed push failed and continues the tick", async () => {
    countDueClipPosts.mockResolvedValue(2);
    dueClipPosts.mockResolvedValue([
      { clipId: "clip-1", scheduledFor: "2026-07-05T00:00:00.000Z" },
      { clipId: "clip-2", scheduledFor: "2026-07-05T01:00:00.000Z" },
    ]);
    pushInstagramReel
      .mockRejectedValueOnce(new Error("Postiz 502"))
      .mockResolvedValueOnce({ postId: "p2" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(await readJson(response)).toEqual({
      attempted: 2,
      captured: 0,
      failed: 1,
      ok: true,
      paused: false,
      posted: 1,
      skippedBlank: 0,
      skippedCapped: 0,
    });
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-1", "failed");
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-2", "posted", { postizId: "p2" });
  });

  it("SKIPS a clip whose caption builds blank — never posts naked, never marks it failed", async () => {
    countDueClipPosts.mockResolvedValue(1);
    dueClipPosts.mockResolvedValue([
      { clipId: "clip-1", scheduledFor: "2026-07-05T00:00:00.000Z" },
    ]);

    buildClipCaption.mockResolvedValue({ builtCaption: "", clipId: "clip-1", coordinates: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(await readJson(response)).toEqual({
      attempted: 1,
      captured: 0,
      failed: 0,
      ok: true,
      paused: false,
      posted: 0,
      skippedBlank: 1,
      skippedCapped: 0,
    });

    expect(pushInstagramReel).not.toHaveBeenCalled();
    expect(setClipPostStatus).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only caption as blank too", async () => {
    countDueClipPosts.mockResolvedValue(1);
    dueClipPosts.mockResolvedValue([
      { clipId: "clip-1", scheduledFor: "2026-07-05T00:00:00.000Z" },
    ]);
    buildClipCaption.mockResolvedValue({
      builtCaption: "  \n\n ",
      clipId: "clip-1",
      coordinates: [],
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    const body = (await readJson(response)) as { skippedBlank: number };
    expect(body.skippedBlank).toBe(1);
    expect(pushInstagramReel).not.toHaveBeenCalled();
  });

  it("skips only the blank clip and still posts its captioned neighbour", async () => {
    countDueClipPosts.mockResolvedValue(2);
    dueClipPosts.mockResolvedValue([
      { clipId: "clip-blank", scheduledFor: "2026-07-05T00:00:00.000Z" },
      { clipId: "clip-2", scheduledFor: "2026-07-05T01:00:00.000Z" },
    ]);
    buildClipCaption.mockImplementation(async (clipId: string) => ({
      builtCaption: clipId === "clip-blank" ? "" : `caption for ${clipId}`,
      clipId,
      coordinates: [],
    }));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(await readJson(response)).toEqual({
      attempted: 2,
      captured: 0,
      failed: 0,
      ok: true,
      paused: false,
      posted: 1,
      skippedBlank: 1,
      skippedCapped: 0,
    });
    expect(pushInstagramReel).toHaveBeenCalledTimes(1);
    expect(pushInstagramReel).toHaveBeenCalledWith({
      caption: "caption for clip-2",
      videoUrl: "https://found.fluncle.com/clip-2/footage.mp4",
    });
    expect(setClipPostStatus).toHaveBeenCalledTimes(1);
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-2", "posted", { postizId: "post-x" });
  });

  it("captures the IG permalink back onto a posted-but-unlinked clip (capture pass)", async () => {
    postedClipPostsAwaitingUrl.mockResolvedValue([{ clipId: "clip-9", postizId: "post-9" }]);

    resolveSocialUrl.mockResolvedValue({
      nativeId: "media-9",
      url: "https://www.instagram.com/reel/AbC123/",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      attempted: 0,
      captured: 1,
      failed: 0,
      ok: true,
      paused: false,
      posted: 0,
      skippedBlank: 0,
      skippedCapped: 0,
    });

    expect(resolveSocialUrl).toHaveBeenCalledWith("post-9", "instagram");
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-9", "posted", {
      postedUrl: "https://www.instagram.com/reel/AbC123/",
    });
    expect(postizSetReleaseId).toHaveBeenCalledWith("post-9", "media-9");
  });

  it("leaves an unresolved post unlinked (retried next tick) — captured 0", async () => {
    postedClipPostsAwaitingUrl.mockResolvedValue([{ clipId: "clip-9", postizId: "post-9" }]);
    resolveSocialUrl.mockResolvedValue(null);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    const body = (await readJson(response)) as { captured: number };
    expect(body.captured).toBe(0);
    expect(setClipPostStatus).not.toHaveBeenCalled();
    expect(postizSetReleaseId).not.toHaveBeenCalled();
  });

  it("runs the capture pass even when the drip is paused", async () => {
    isDripPaused.mockResolvedValue(true);
    postedClipPostsAwaitingUrl.mockResolvedValue([{ clipId: "clip-9", postizId: "post-9" }]);
    resolveSocialUrl.mockResolvedValue({
      nativeId: "media-9",
      url: "https://www.instagram.com/reel/AbC123/",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(await readJson(response)).toEqual({
      attempted: 0,
      captured: 1,
      failed: 0,
      ok: true,
      paused: true,
      posted: 0,
      skippedBlank: 0,
      skippedCapped: 0,
    });
    expect(pushInstagramReel).not.toHaveBeenCalled();
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-9", "posted", {
      postedUrl: "https://www.instagram.com/reel/AbC123/",
    });
  });
});

describe("oRPC list_clip_posts (GET /admin/clips/social)", () => {
  it("lets the AGENT read the drip rows", async () => {
    listClipPosts.mockResolvedValue([
      {
        clipId: "clip-1",
        createdAt: "2026-07-05T00:00:00.000Z",
        platform: "instagram",
        scheduledFor: "2026-07-06T12:00:00.000Z",
        status: "scheduled",
        updatedAt: "2026-07-05T00:00:00.000Z",
      },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/social", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { ok: boolean; posts: Array<{ clipId: string }> };
    expect(body.ok).toBe(true);
    expect(body.posts[0]?.clipId).toBe("clip-1");
  });
});

describe("oRPC set_clip_schedule (PATCH /admin/clips/{clipId}/schedule)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/clip-1/schedule", "PATCH", AGENT_TOKEN, {
        scheduledFor: "2026-07-07T12:00:00.000Z",
      }),
    );
    expect(response?.status).toBe(403);
  });

  it("lets the OPERATOR set a slot (re-snapshots the caption, upserts, reads back)", async () => {
    getClip.mockResolvedValue({ id: "clip-1" });
    getClipPost.mockResolvedValue({
      clipId: "clip-1",
      createdAt: "2026-07-05T00:00:00.000Z",
      platform: "instagram",
      scheduledFor: "2026-07-07T12:00:00.000Z",
      status: "scheduled",
      updatedAt: "2026-07-05T00:00:00.000Z",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/clip-1/schedule", "PATCH", OPERATOR_TOKEN, {
        scheduledFor: "2026-07-07T12:00:00.000Z",
      }),
    );

    expect(response?.status).toBe(200);
    expect(upsertClipPost).toHaveBeenCalledWith({
      caption: "caption for clip-1",
      clipId: "clip-1",
      scheduledFor: "2026-07-07T12:00:00.000Z",
    });
    const body = (await readJson(response)) as { ok: boolean; post: { scheduledFor: string } };
    expect(body.post.scheduledFor).toBe("2026-07-07T12:00:00.000Z");
  });
});

describe("oRPC set_clip_schedules (POST /admin/clips/schedule)", () => {
  it("403s the AGENT (operator-only, like the single sibling)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/schedule", "POST", AGENT_TOKEN, { clipIds: ["clip-1", "clip-2"] }),
    );
    expect(response?.status).toBe(403);
  });

  it("lets the OPERATOR batch-schedule a selection (a fresh caption + slot per clip)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/schedule", "POST", OPERATOR_TOKEN, { clipIds: ["clip-1", "clip-2"] }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, scheduled: 2 });

    expect(upsertClipPost).toHaveBeenCalledTimes(2);
    expect(upsertClipPost).toHaveBeenCalledWith({
      caption: "caption for clip-1",
      clipId: "clip-1",
      scheduledFor: "2026-07-06T12:00:00.000Z",
    });
    expect(upsertClipPost).toHaveBeenCalledWith({
      caption: "caption for clip-2",
      clipId: "clip-2",
      scheduledFor: "2026-07-06T12:00:00.000Z",
    });
  });

  it("is a no-op for an empty selection (scheduled 0)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/schedule", "POST", OPERATOR_TOKEN, { clipIds: [] }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, scheduled: 0 });
    expect(upsertClipPost).not.toHaveBeenCalled();
  });
});

describe("oRPC delete_clip_schedule (DELETE /admin/clips/{clipId}/schedule)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/clip-1/schedule", "DELETE", AGENT_TOKEN));
    expect(response?.status).toBe(403);
  });

  it("lets the OPERATOR unschedule a clip (confirms it exists, deletes its row)", async () => {
    getClip.mockResolvedValue({ id: "clip-1" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/clip-1/schedule", "DELETE", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(getClip).toHaveBeenCalledWith("clip-1");
    expect(deleteClipPost).toHaveBeenCalledWith("clip-1");
  });
});

describe("oRPC set_clip_drip (PUT /admin/clips/drip/state)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/clips/drip/state", "PUT", AGENT_TOKEN, { paused: true }),
    );
    expect(response?.status).toBe(403);
  });

  it("lets the OPERATOR pause + resume", async () => {
    const { handleOrpc } = await import("./orpc");

    const paused = await handleOrpc(
      req("/admin/clips/drip/state", "PUT", OPERATOR_TOKEN, { paused: true }),
    );
    expect(paused?.status).toBe(200);
    expect(await readJson(paused)).toEqual({ ok: true, paused: true });
    expect(setDripPaused).toHaveBeenCalledWith(true);

    const resumed = await handleOrpc(
      req("/admin/clips/drip/state", "PUT", OPERATOR_TOKEN, { paused: false }),
    );
    expect(await readJson(resumed)).toEqual({ ok: true, paused: false });
    expect(setDripPaused).toHaveBeenCalledWith(false);
  });
});
