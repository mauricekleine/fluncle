import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "./orpc-test-helpers";

// The admin wave's `admin-social` parity + auth proof, driven end-to-end through
// `handleOrpc`. The security-critical piece is the FIELD-LEVEL operator guard on
// `draft_track_social`: the live route is `requireAdmin`, then `youtube` (a direct
// PUBLIC upload) additionally requires the operator, while `tiktok` (a SELF_ONLY
// inbox draft) is agent-allowed.
//
//   - list_track_social — admin tier (live `requireAdmin`).
//   - update_track_social — operator tier (live `requireOperator`).
//   - draft_track_social — admin tier WITH the per-platform operator branch: a
//     youtube push by the agent is a 403, a tiktok push by the agent is allowed.

const getTrackByIdOrLogId = vi.fn();
const listSocialPosts = vi.fn();
const updateSocialStatus = vi.fn();
const upsertPost = vi.fn();
const pushTikTokDraft = vi.fn();
const pushYouTubeShort = vi.fn();
const readCaptions = vi.fn();

vi.mock("./tracks", () => ({
  getTrackByIdOrLogId: (id: string) => getTrackByIdOrLogId(id),
}));

vi.mock("./social", () => ({
  listSocialPosts: (...args: unknown[]) => listSocialPosts(...args),
  updateSocialStatus: (...args: unknown[]) => updateSocialStatus(...args),
  upsertPost: (...args: unknown[]) => upsertPost(...args),
}));

vi.mock("./postiz", () => ({
  pushTikTokDraft: (...args: unknown[]) => pushTikTokDraft(...args),
  pushYouTubeShort: (...args: unknown[]) => pushYouTubeShort(...args),
}));

vi.mock("./captions", () => ({
  readCaptions: (...args: unknown[]) => readCaptions(...args),
}));

const OPERATOR_TOKEN = "test-token-admin-operator";
const AGENT_TOKEN = "test-token-admin-agent";
const TRACK_ID = "track-123";

const TRACK = {
  artists: ["Calibre"],
  logId: "004.7.2I",
  title: "Mr Right On",
  trackId: TRACK_ID,
  videoUrl: "https://found.fluncle.com/004.7.2I/footage.mp4",
};

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
});

beforeEach(() => {
  getTrackByIdOrLogId.mockReset();
  listSocialPosts.mockReset();
  updateSocialStatus.mockReset();
  upsertPost.mockReset();
  pushTikTokDraft.mockReset();
  pushYouTubeShort.mockReset();
  readCaptions.mockReset().mockResolvedValue({ "004.7.2I": "a caption" });
});

function req(path: string, method: string, token: string | undefined, body?: unknown): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return new Request(`https://www.fluncle.com/api/v1${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
}

// ── list_track_social — admin tier ───────────────────────────────────────────
describe("oRPC list_track_social (GET /admin/tracks/{trackId}/social)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/tracks/${TRACK_ID}/social`, "GET", undefined));

    expect(response?.status).toBe(401);
  });

  it("lets the AGENT read and returns the live envelope", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    listSocialPosts.mockResolvedValueOnce([
      { createdAt: "t", platform: "tiktok", status: "draft", updatedAt: "t" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/tracks/${TRACK_ID}/social`, "GET", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ok: true,
      posts: [{ createdAt: "t", platform: "tiktok", status: "draft", updatedAt: "t" }],
      trackId: TRACK_ID,
    });
  });

  it("404s `not_found` for an unknown track", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social`, "GET", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(404);
    expect(((await readJson(response)) as { code: string }).code).toBe("not_found");
  });
});

// ── update_track_social — operator tier ──────────────────────────────────────
describe("oRPC update_track_social (PATCH .../social/{platform})", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok`, "PATCH", AGENT_TOKEN, { status: "published" }),
    );

    expect(response?.status).toBe(403);
    expect(updateSocialStatus).not.toHaveBeenCalled();
  });

  it("400s `bad_status` for an invalid status", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok`, "PATCH", OPERATOR_TOKEN, { status: "weird" }),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("bad_status");
  });

  it("400s `url_required` publishing without a url", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok`, "PATCH", OPERATOR_TOKEN, {
        status: "published",
      }),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("url_required");
  });

  it("404s `no_post` when no platform row exists", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateSocialStatus.mockResolvedValueOnce(false);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok`, "PATCH", OPERATOR_TOKEN, {
        status: "scheduled",
      }),
    );

    expect(response?.status).toBe(404);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_post");
  });

  it("updates for the operator and returns the live envelope", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateSocialStatus.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok`, "PATCH", OPERATOR_TOKEN, {
        status: "published",
        url: "https://tiktok.com/x",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ok: true,
      platform: "tiktok",
      status: "published",
      trackId: TRACK_ID,
    });
    expect(updateSocialStatus).toHaveBeenCalledWith(TRACK_ID, "tiktok", {
      status: "published",
      url: "https://tiktok.com/x",
    });
  });
});

// ── draft_track_social — admin tier + per-platform operator guard ────────────
describe("oRPC draft_track_social (POST .../social/{platform}/draft)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok/draft`, "POST", undefined),
    );

    expect(response?.status).toBe(401);
  });

  it("400s `unsupported_platform` before the operator gate", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/instagram/draft`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("unsupported_platform");
  });

  it("403s the AGENT pushing to YOUTUBE (operator-only platform)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/youtube/draft`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(403);
    expect(((await readJson(response)) as { code: string }).code).toBe("forbidden");
    // The operator gate fires BEFORE the track lookup, exactly as the live route.
    expect(getTrackByIdOrLogId).not.toHaveBeenCalled();
  });

  it("lets the AGENT push to TIKTOK (a SELF_ONLY inbox draft)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    pushTikTokDraft.mockResolvedValueOnce({ postId: "tt-1" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok/draft`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      externalId: "tt-1",
      ok: true,
      platform: "tiktok",
      status: "draft",
      trackId: TRACK_ID,
    });
    expect(pushTikTokDraft).toHaveBeenCalled();
    expect(upsertPost).toHaveBeenCalledWith(TRACK_ID, "tiktok", "draft", "tt-1");
  });

  it("lets the OPERATOR push to YOUTUBE (published)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    pushYouTubeShort.mockResolvedValueOnce({ postId: "yt-1" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/youtube/draft`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      externalId: "yt-1",
      ok: true,
      platform: "youtube",
      status: "published",
      trackId: TRACK_ID,
    });
    expect(pushYouTubeShort).toHaveBeenCalled();
    expect(upsertPost).toHaveBeenCalledWith(TRACK_ID, "youtube", "published", "yt-1");
  });

  it("400s `no_video` when the track has no video", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, videoUrl: undefined });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok/draft`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_video");
  });
});
