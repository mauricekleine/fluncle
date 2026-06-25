import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

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
//   - capture_post_urls — admin tier: the polling sweep. It resolves each pending
//     post's permalink from the platform native id and records it.

const getTrackByIdOrLogId = vi.fn();
const listSocialPosts = vi.fn();
const updateSocialStatus = vi.fn();
const upsertPost = vi.fn();
const hasPostAwaitingUrl = vi.fn();
const listPostsAwaitingUrl = vi.fn();
const recordPostUrl = vi.fn();
const pushTikTokDraft = vi.fn();
const pushYouTubeShort = vi.fn();
const resolveSocialUrl = vi.fn();
const postizSetReleaseId = vi.fn();
const readCaptions = vi.fn();

vi.mock("./tracks", () => ({
  getTrackByIdOrLogId: (id: string) => getTrackByIdOrLogId(id),
}));

vi.mock("./social", () => ({
  hasPostAwaitingUrl: (...args: unknown[]) => hasPostAwaitingUrl(...args),
  listPostsAwaitingUrl: (...args: unknown[]) => listPostsAwaitingUrl(...args),
  listSocialPosts: (...args: unknown[]) => listSocialPosts(...args),
  recordPostUrl: (...args: unknown[]) => recordPostUrl(...args),
  updateSocialStatus: (...args: unknown[]) => updateSocialStatus(...args),
  upsertPost: (...args: unknown[]) => upsertPost(...args),
}));

vi.mock("./postiz", () => ({
  postizSetReleaseId: (...args: unknown[]) => postizSetReleaseId(...args),
  pushTikTokDraft: (...args: unknown[]) => pushTikTokDraft(...args),
  pushYouTubeShort: (...args: unknown[]) => pushYouTubeShort(...args),
  resolveSocialUrl: (...args: unknown[]) => resolveSocialUrl(...args),
}));

vi.mock("./captions", () => ({
  readCaptions: (...args: unknown[]) => readCaptions(...args),
}));

const TRACK_ID = "track-123";

const TRACK = {
  artists: ["Calibre"],
  logId: "004.7.2I",
  title: "Mr Right On",
  trackId: TRACK_ID,
  videoUrl: "https://found.fluncle.com/004.7.2I/footage.mp4",
};

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  getTrackByIdOrLogId.mockReset();
  listSocialPosts.mockReset();
  updateSocialStatus.mockReset().mockResolvedValue(true);
  upsertPost.mockReset();
  hasPostAwaitingUrl.mockReset().mockResolvedValue(false);
  listPostsAwaitingUrl.mockReset().mockResolvedValue([]);
  recordPostUrl.mockReset().mockResolvedValue(true);
  pushTikTokDraft.mockReset();
  pushYouTubeShort.mockReset();
  resolveSocialUrl.mockReset().mockResolvedValue(null);
  postizSetReleaseId.mockReset().mockResolvedValue(undefined);
  readCaptions.mockReset().mockResolvedValue({ "004.7.2I": "a caption" });
});

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

  it("lets the OPERATOR push to YOUTUBE (published); url unresolved leaves it null", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    pushYouTubeShort.mockResolvedValueOnce({ postId: "yt-1" });
    // The publish lag: /missing resolves nothing this time, so no url is recorded.
    resolveSocialUrl.mockResolvedValueOnce(null);

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
    expect(resolveSocialUrl).toHaveBeenCalledWith("yt-1", "youtube");
    // No url resolved → nothing recorded, no release-id linked; the operator's
    // manual entry (or the capture sweep) is the fallback.
    expect(recordPostUrl).not.toHaveBeenCalled();
    expect(postizSetReleaseId).not.toHaveBeenCalled();
  });

  it("auto-records the live YouTube URL + links the release-id when /missing resolves it", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    pushYouTubeShort.mockResolvedValueOnce({ postId: "yt-2" });
    // /missing returns the native videoId; the handler builds the /shorts/ permalink.
    resolveSocialUrl.mockResolvedValueOnce({
      nativeId: "abc123",
      url: "https://www.youtube.com/shorts/abc123",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/youtube/draft`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(200);
    // The draft envelope is unchanged; the resolved url is a side-effect on the
    // row (surfaced via list_track_social), not part of the response.
    expect(await readJson(response)).toEqual({
      externalId: "yt-2",
      ok: true,
      platform: "youtube",
      status: "published",
      trackId: TRACK_ID,
    });
    expect(resolveSocialUrl).toHaveBeenCalledWith("yt-2", "youtube");
    expect(recordPostUrl).toHaveBeenCalledWith(
      TRACK_ID,
      "youtube",
      "https://www.youtube.com/shorts/abc123",
    );
    // The native id links the post to its content for Postiz analytics.
    expect(postizSetReleaseId).toHaveBeenCalledWith("yt-2", "abc123");
  });

  it("409s the push gate when a YouTube post is still awaiting its URL", async () => {
    hasPostAwaitingUrl.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/youtube/draft`, "POST", OPERATOR_TOKEN),
    );

    expect(response?.status).toBe(409);
    expect(((await readJson(response)) as { code: string }).code).toBe("youtube_url_pending");
    // The gate fires BEFORE the track lookup and the push — nothing is published.
    expect(getTrackByIdOrLogId).not.toHaveBeenCalled();
    expect(pushYouTubeShort).not.toHaveBeenCalled();
  });

  it("the gate does NOT block a TIKTOK push (youtube-only)", async () => {
    // A pending youtube URL must not stop a tiktok draft.
    hasPostAwaitingUrl.mockResolvedValue(true);
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    pushTikTokDraft.mockResolvedValueOnce({ postId: "tt-9" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req(`/admin/tracks/${TRACK_ID}/social/tiktok/draft`, "POST", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(pushTikTokDraft).toHaveBeenCalled();
    // The youtube gate was never consulted for a tiktok push.
    expect(hasPostAwaitingUrl).not.toHaveBeenCalled();
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

// ── permalinkFromMissingId — the native id → permalink mapping ────────────────
// The load-bearing fix: Postiz's /missing `id` is the platform's NATIVE content id
// (the TikTok aweme id / the YouTube videoId), so the permalink is BUILT from it,
// per platform. (The pure function is imported un-mocked via importActual.)
describe("permalinkFromMissingId (native id → permalink, per platform)", () => {
  it("builds a YouTube Shorts permalink from the videoId", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("youtube", "dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    );
  });

  it("builds a TikTok @fluncle/video permalink from the aweme id", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("tiktok", "7280000000000000000")).toBe(
      "https://www.tiktok.com/@fluncle/video/7280000000000000000",
    );
  });

  it("yields null for an empty id (defensive — unverified id shape)", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("youtube", "   ")).toBeNull();
    expect(permalinkFromMissingId("tiktok", "")).toBeNull();
  });

  it("yields null for an unknown platform", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("instagram", "anything")).toBeNull();
  });

  it("passes through an already-absolute URL (in case Postiz ever returns one)", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("youtube", "https://youtu.be/abc123")).toBe(
      "https://youtu.be/abc123",
    );
  });
});

// ── capture_post_urls — the polling sweep ────────────────────────────────────
describe("oRPC capture_post_urls (POST /admin/social/posts/capture)", () => {
  it("401s with no token", async () => {
    // A JSON body (the CLI always sends one) so auth is reached: a bodyless POST
    // would 400 on input validation before the auth middleware runs.
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/social/posts/capture`, "POST", undefined, {}));

    expect(response?.status).toBe(401);
  });

  it("lets the AGENT run the sweep (it only fills the public URL)", async () => {
    listPostsAwaitingUrl.mockResolvedValueOnce([]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/social/posts/capture`, "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ captured: [], ok: true, polled: 0 });
  });

  it("selects youtube+tiktok pending posts, records each url, and links the release-id", async () => {
    listPostsAwaitingUrl.mockResolvedValueOnce([
      { externalId: "yt-9", platform: "youtube", status: "published", trackId: "t-yt" },
      { externalId: "tt-9", platform: "tiktok", status: "draft", trackId: "t-tt" },
    ]);
    resolveSocialUrl
      .mockResolvedValueOnce({ nativeId: "vid9", url: "https://www.youtube.com/shorts/vid9" })
      .mockResolvedValueOnce({
        nativeId: "aweme9",
        url: "https://www.tiktok.com/@fluncle/video/aweme9",
      });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/social/posts/capture`, "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      captured: [
        { platform: "youtube", trackId: "t-yt", url: "https://www.youtube.com/shorts/vid9" },
        {
          platform: "tiktok",
          trackId: "t-tt",
          url: "https://www.tiktok.com/@fluncle/video/aweme9",
        },
      ],
      ok: true,
      polled: 2,
    });

    // Each pending post is polled by its OWN post id + platform.
    expect(resolveSocialUrl).toHaveBeenCalledWith("yt-9", "youtube");
    expect(resolveSocialUrl).toHaveBeenCalledWith("tt-9", "tiktok");

    // The url is recorded (fill-empty-only) and the release-id linked for both.
    expect(recordPostUrl).toHaveBeenCalledWith(
      "t-yt",
      "youtube",
      "https://www.youtube.com/shorts/vid9",
    );
    expect(recordPostUrl).toHaveBeenCalledWith(
      "t-tt",
      "tiktok",
      "https://www.tiktok.com/@fluncle/video/aweme9",
    );
    expect(postizSetReleaseId).toHaveBeenCalledWith("yt-9", "vid9");
    expect(postizSetReleaseId).toHaveBeenCalledWith("tt-9", "aweme9");

    // A captured TikTok DRAFT flips to published (it reached the app + went live);
    // the YouTube post was already published, so it is not re-flipped.
    expect(updateSocialStatus).toHaveBeenCalledTimes(1);
    expect(updateSocialStatus).toHaveBeenCalledWith("t-tt", "tiktok", {
      status: "published",
      url: "https://www.tiktok.com/@fluncle/video/aweme9",
    });
  });

  it("skips a post whose /missing has not resolved yet (counts as polled, not captured)", async () => {
    listPostsAwaitingUrl.mockResolvedValueOnce([
      { externalId: "yt-lag", platform: "youtube", status: "published", trackId: "t-lag" },
    ]);
    resolveSocialUrl.mockResolvedValueOnce(null);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/social/posts/capture`, "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ captured: [], ok: true, polled: 1 });
    expect(recordPostUrl).not.toHaveBeenCalled();
    expect(postizSetReleaseId).not.toHaveBeenCalled();
    expect(updateSocialStatus).not.toHaveBeenCalled();
  });

  it("does NOT flip a TikTok draft when the url could not be recorded (row vanished)", async () => {
    listPostsAwaitingUrl.mockResolvedValueOnce([
      { externalId: "tt-gone", platform: "tiktok", status: "draft", trackId: "t-gone" },
    ]);
    resolveSocialUrl.mockResolvedValueOnce({
      nativeId: "aweme0",
      url: "https://www.tiktok.com/@fluncle/video/aweme0",
    });
    // recordPostUrl fills nothing (no empty-url row to fill).
    recordPostUrl.mockResolvedValueOnce(false);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/social/posts/capture`, "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ captured: [], ok: true, polled: 1 });
    expect(postizSetReleaseId).not.toHaveBeenCalled();
    expect(updateSocialStatus).not.toHaveBeenCalled();
  });
});
