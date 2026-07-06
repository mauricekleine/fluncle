import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// The clip drip-feed ops, driven end-to-end through `handleOrpc`. Proves:
//   - the auth tiers: drip_clips + list_clip_posts are ADMIN (the AGENT box token
//     passes); set_clip_schedule + set_clip_drip are OPERATOR (the agent is 403);
//   - the drip logic: the kill switch no-ops the tick; due selection posts within the
//     per-tick + 24h budget; a push error marks the row failed and never aborts the tick.
// The store (`./clip-social`), Postiz (`./postiz`), the caption builder, and the clip
// download URL are all mocked — the handler's job is the orchestration, not the DB/network.

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

vi.mock("./clip-social", () => ({
  countDueClipPosts: (...a: unknown[]) => countDueClipPosts(...a),
  countRecentPostedInWindow: (...a: unknown[]) => countRecentPostedInWindow(...a),
  deleteClipPost: (...a: unknown[]) => deleteClipPost(...a),
  dueClipPosts: (...a: unknown[]) => dueClipPosts(...a),
  getClipPost: (...a: unknown[]) => getClipPost(...a),
  isDripPaused: (...a: unknown[]) => isDripPaused(...a),
  listClipPosts: (...a: unknown[]) => listClipPosts(...a),
  nextDripSlot: async () => "2026-07-06T12:00:00.000Z",
  setClipPostStatus: (...a: unknown[]) => setClipPostStatus(...a),
  setDripPaused: (...a: unknown[]) => setDripPaused(...a),
  upsertClipPost: (...a: unknown[]) => upsertClipPost(...a),
}));

const pushInstagramReel = vi.fn();

vi.mock("./postiz", () => ({
  pushInstagramReel: (...a: unknown[]) => pushInstagramReel(...a),
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

beforeEach(() => {
  vi.clearAllMocks();
  isDripPaused.mockResolvedValue(false);
  countRecentPostedInWindow.mockResolvedValue(0);
  countDueClipPosts.mockResolvedValue(0);
  dueClipPosts.mockResolvedValue([]);
  buildClipCaption.mockImplementation(async (clipId: string) => ({
    builtCaption: `caption for ${clipId}`,
    clipId,
    coordinates: [],
  }));
  pushInstagramReel.mockResolvedValue({ postId: "post-x" });
});

// ── drip_clips — ADMIN tier (the box's agent token drives it) ────────────────
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
      failed: 0,
      ok: true,
      paused: true,
      posted: 0,
      skippedCapped: 0,
    });
    expect(dueClipPosts).not.toHaveBeenCalled();
    expect(pushInstagramReel).not.toHaveBeenCalled();
  });

  it("posts the due clips (agent token) and marks each posted", async () => {
    countDueClipPosts.mockResolvedValue(2);
    dueClipPosts.mockResolvedValue([
      { caption: "c1", clipId: "clip-1", scheduledFor: "2026-07-05T00:00:00.000Z" },
      { caption: "c2", clipId: "clip-2", scheduledFor: "2026-07-05T01:00:00.000Z" },
    ]);
    pushInstagramReel
      .mockResolvedValueOnce({ postId: "p1" })
      .mockResolvedValueOnce({ postId: "p2" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      attempted: 2,
      failed: 0,
      ok: true,
      paused: false,
      posted: 2,
      skippedCapped: 0,
    });
    expect(pushInstagramReel).toHaveBeenCalledTimes(2);
    // Caption rebuilt fresh at fire time; the with-audio clip URL is pulled.
    expect(pushInstagramReel).toHaveBeenCalledWith({
      caption: "caption for clip-1",
      videoUrl: "https://found.fluncle.com/clip-1/footage.mp4",
    });
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-1", "posted", { postizId: "p1" });
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-2", "posted", { postizId: "p2" });
  });

  it("clamps the budget to the rolling-24h cap and reports skippedCapped", async () => {
    // 9 already posted in 24h → remaining24h = 10 - 9 = 1; per-tick cap 3 ⇒ budget 1.
    countRecentPostedInWindow.mockResolvedValue(9);
    countDueClipPosts.mockResolvedValue(5); // 5 due, only 1 postable this tick
    dueClipPosts.mockResolvedValue([
      { caption: "c1", clipId: "clip-1", scheduledFor: "2026-07-05T00:00:00.000Z" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    // dueClipPosts was asked for at most the clamped budget of 1.
    expect(dueClipPosts).toHaveBeenCalledWith({ limit: 1 });
    expect(await readJson(response)).toEqual({
      attempted: 1,
      failed: 0,
      ok: true,
      paused: false,
      posted: 1,
      skippedCapped: 4, // 5 due − 1 posted this tick
    });
  });

  it("marks a failed push failed and continues the tick", async () => {
    countDueClipPosts.mockResolvedValue(2);
    dueClipPosts.mockResolvedValue([
      { caption: "c1", clipId: "clip-1", scheduledFor: "2026-07-05T00:00:00.000Z" },
      { caption: "c2", clipId: "clip-2", scheduledFor: "2026-07-05T01:00:00.000Z" },
    ]);
    pushInstagramReel
      .mockRejectedValueOnce(new Error("Postiz 502"))
      .mockResolvedValueOnce({ postId: "p2" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/clips/drip", "POST", AGENT_TOKEN, {}));

    expect(await readJson(response)).toEqual({
      attempted: 2,
      failed: 1,
      ok: true,
      paused: false,
      posted: 1,
      skippedCapped: 0,
    });
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-1", "failed");
    expect(setClipPostStatus).toHaveBeenCalledWith("clip-2", "posted", { postizId: "p2" });
  });
});

// ── list_clip_posts — ADMIN tier ─────────────────────────────────────────────
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

// ── set_clip_schedule — OPERATOR tier ────────────────────────────────────────
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

// ── delete_clip_schedule — OPERATOR tier (unschedule) ────────────────────────
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

// ── set_clip_drip — OPERATOR tier (the kill switch) ──────────────────────────
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
