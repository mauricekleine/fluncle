import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const isUrlClaimedByOtherTrack = vi.fn();
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
  isUrlClaimedByOtherTrack: (...args: unknown[]) => isUrlClaimedByOtherTrack(...args),
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
  isUrlClaimedByOtherTrack.mockReset().mockResolvedValue(false);
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

  it("auto-records the live YouTube URL + links the release-id when it resolves", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    pushYouTubeShort.mockResolvedValueOnce({ postId: "yt-2" });
    // The resolver reads the releaseId (the videoId) off the dated /posts list and
    // builds the canonical Short URL; that is what the caller records.
    resolveSocialUrl.mockResolvedValueOnce({
      nativeId: "h61ZuxQVnBA",
      url: "https://www.youtube.com/shorts/h61ZuxQVnBA",
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
    // The canonical Short URL the resolver built is what gets recorded.
    expect(recordPostUrl).toHaveBeenCalledWith(
      TRACK_ID,
      "youtube",
      "https://www.youtube.com/shorts/h61ZuxQVnBA",
    );
    // The videoId links the post to its content for Postiz analytics.
    expect(postizSetReleaseId).toHaveBeenCalledWith("yt-2", "h61ZuxQVnBA");
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

// ── permalinkFromMissingId — TikTok's native aweme id → permalink ─────────────
// Verified against live Postiz: only TikTok needs this builder — its `releaseURL`
// is a useless `…/messages?…` placeholder, so the permalink is BUILT from the
// `/missing` native aweme id. YouTube reads its real `releaseURL` straight off the
// post (so this returns null for youtube). (Imported un-mocked via importActual.)
describe("permalinkFromMissingId (TikTok native aweme id → permalink)", () => {
  it("builds a TikTok @fluncle/video permalink from the aweme id", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("tiktok", "7280000000000000000")).toBe(
      "https://www.tiktok.com/@fluncle/video/7280000000000000000",
    );
  });

  it("yields null for youtube — it reads releaseURL off the post, not /missing", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("youtube", "dQw4w9WgXcQ")).toBeNull();
  });

  it("yields null for an empty id (defensive)", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("tiktok", "   ")).toBeNull();
    expect(permalinkFromMissingId("tiktok", "")).toBeNull();
  });

  it("yields null for an unknown platform", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("instagram", "anything")).toBeNull();
  });

  it("passes through an already-absolute URL in the id (in case Postiz returns one)", async () => {
    const { permalinkFromMissingId } = await vi.importActual<typeof import("./postiz")>("./postiz");

    expect(permalinkFromMissingId("tiktok", "https://www.tiktok.com/@fluncle/video/abc")).toBe(
      "https://www.tiktok.com/@fluncle/video/abc",
    );
  });
});

// ── resolveSocialUrl — the corrected resolver, against a mocked Postiz ─────────
// Verified against live Postiz (see the postiz.ts doctrine):
//   - YouTube: read the dated `/posts` list, find the post by id, and once it's
//     PUBLISHED with an auto-populated `releaseId` + a real YouTube `releaseURL`,
//     return that URL VERBATIM (never reconstruct it).
//   - TikTok: fall back to `/missing` (its `releaseURL` is a `…/messages?…`
//     placeholder) and BUILD the permalink from the newest native aweme id.
// `resolveSocialUrl` is imported un-mocked via importActual; only global `fetch`
// (the Postiz HTTP boundary) and `POSTIZ_API_KEY` are stubbed.
describe("resolveSocialUrl (YouTube releaseURL / TikTok /missing)", () => {
  const ORIGINAL_KEY = process.env.POSTIZ_API_KEY;
  const ORIGINAL_URL = process.env.POSTIZ_API_URL;

  beforeEach(() => {
    process.env.POSTIZ_API_KEY = "test-postiz-key";
    process.env.POSTIZ_API_URL = "https://api.postiz.test/public/v1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.POSTIZ_API_KEY = ORIGINAL_KEY;
    process.env.POSTIZ_API_URL = ORIGINAL_URL;
  });

  // A tiny router over the Postiz endpoints `resolveSocialUrl` touches. Routes
  // return a verbatim body string (so we can reproduce the unescaped newline
  // Postiz really sends in the dated list `content`).
  function mockPostiz(routes: Array<{ body: string; match: string }>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        const route = routes.find((candidate) => url.includes(candidate.match));

        if (!route) {
          return new Response("not found", { status: 404 });
        }

        return new Response(route.body, { status: 200 });
      }),
    );
  }

  it("YouTube: captures the canonical /shorts/<id> URL built from the videoId once PUBLISHED", async () => {
    const { resolveSocialUrl } = await vi.importActual<typeof import("./postiz")>("./postiz");

    // The dated /posts list. NOTE the unescaped newline in `content` — exactly the
    // shape live Postiz returns — to prove the lenient parse recovers the post.
    // Postiz auto-populates `releaseURL` as a `watch?v=<id>` URL; we capture the
    // canonical Short form built from `releaseId` (the videoId) instead.
    const listBody =
      '{"posts":[' +
      '{"id":"yt-live","state":"PUBLISHED","releaseId":"h61ZuxQVnBA",' +
      '"releaseURL":"https://www.youtube.com/watch?v=h61ZuxQVnBA",' +
      '"content":"Sea Air\nfluncle://011.6.8K","integration":{"providerIdentifier":"youtube"}}' +
      "]}";

    mockPostiz([{ body: listBody, match: "/posts?" }]);

    const resolved = await resolveSocialUrl("yt-live", "youtube");

    expect(resolved).toEqual({
      nativeId: "h61ZuxQVnBA",
      url: "https://www.youtube.com/shorts/h61ZuxQVnBA",
    });
  });

  it("YouTube: returns null while the post is not PUBLISHED yet (sweep retries)", async () => {
    const { resolveSocialUrl } = await vi.importActual<typeof import("./postiz")>("./postiz");

    const listBody =
      '{"posts":[{"id":"yt-pending","state":"QUEUE","releaseId":"missing","releaseURL":null}]}';

    mockPostiz([{ body: listBody, match: "/posts?" }]);

    expect(await resolveSocialUrl("yt-pending", "youtube")).toBeNull();
  });

  it("YouTube: returns null when releaseURL is the placeholder, not a real URL", async () => {
    const { resolveSocialUrl } = await vi.importActual<typeof import("./postiz")>("./postiz");

    // PUBLISHED but releaseURL is a non-YouTube placeholder → not a real permalink.
    const listBody =
      '{"posts":[{"id":"yt-x","state":"PUBLISHED","releaseId":"missing",' +
      '"releaseURL":"https://www.tiktok.com/messages?lang=en"}]}';

    mockPostiz([{ body: listBody, match: "/posts?" }]);

    expect(await resolveSocialUrl("yt-x", "youtube")).toBeNull();
  });

  it("TikTok: builds the @fluncle/video permalink from the newest /missing aweme id", async () => {
    const { resolveSocialUrl } = await vi.importActual<typeof import("./postiz")>("./postiz");

    // The /missing body for a finished inbox draft: [{ id: awemeId, url: cover }].
    const missingBody =
      '[{"id":"7280000000000000000","url":"https://p16.tiktokcdn.com/cover.jpg"}]';

    mockPostiz([{ body: missingBody, match: "/missing" }]);

    const resolved = await resolveSocialUrl("tt-live", "tiktok");

    expect(resolved).toEqual({
      nativeId: "7280000000000000000",
      url: "https://www.tiktok.com/@fluncle/video/7280000000000000000",
    });
  });

  it("TikTok: returns null when /missing is empty (not finished in-app yet)", async () => {
    const { resolveSocialUrl } = await vi.importActual<typeof import("./postiz")>("./postiz");

    mockPostiz([{ body: "[]", match: "/missing" }]);

    expect(await resolveSocialUrl("tt-pending", "tiktok")).toBeNull();
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
      .mockResolvedValueOnce({
        nativeId: "vid9",
        url: "https://www.youtube.com/shorts/vid9",
      })
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

  it("skips a TikTok URL already claimed by another track (the unpublished-draft trap)", async () => {
    // The just-pushed draft (t-new) still sits unpublished in the inbox, so
    // TikTok's /missing returns the @fluncle account's NEWEST aweme — which is
    // the PREVIOUS track's video, a URL already stored on another track's row.
    listPostsAwaitingUrl.mockResolvedValueOnce([
      { externalId: "tt-new", platform: "tiktok", status: "draft", trackId: "t-new" },
    ]);
    resolveSocialUrl.mockResolvedValueOnce({
      nativeId: "awemePrev",
      url: "https://www.tiktok.com/@fluncle/video/awemePrev",
    });
    // That URL is already attached to a different track → do not re-use it.
    isUrlClaimedByOtherTrack.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/social/posts/capture`, "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    // Polled but not captured — the row stays pending until a fresh permalink.
    expect(await readJson(response)).toEqual({ captured: [], ok: true, polled: 1 });
    expect(isUrlClaimedByOtherTrack).toHaveBeenCalledWith(
      "https://www.tiktok.com/@fluncle/video/awemePrev",
      "t-new",
    );
    // Nothing is written: no url recorded, no release-id linked, no draft flip.
    expect(recordPostUrl).not.toHaveBeenCalled();
    expect(postizSetReleaseId).not.toHaveBeenCalled();
    expect(updateSocialStatus).not.toHaveBeenCalled();
  });

  it("captures a fresh, unclaimed TikTok URL (draft now published in-app)", async () => {
    listPostsAwaitingUrl.mockResolvedValueOnce([
      { externalId: "tt-fresh", platform: "tiktok", status: "draft", trackId: "t-fresh" },
    ]);
    resolveSocialUrl.mockResolvedValueOnce({
      nativeId: "awemeFresh",
      url: "https://www.tiktok.com/@fluncle/video/awemeFresh",
    });
    // The newest aweme is unclaimed → this draft really did go live in-app.
    isUrlClaimedByOtherTrack.mockResolvedValueOnce(false);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(`/admin/social/posts/capture`, "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      captured: [
        {
          platform: "tiktok",
          trackId: "t-fresh",
          url: "https://www.tiktok.com/@fluncle/video/awemeFresh",
        },
      ],
      ok: true,
      polled: 1,
    });
    expect(recordPostUrl).toHaveBeenCalledWith(
      "t-fresh",
      "tiktok",
      "https://www.tiktok.com/@fluncle/video/awemeFresh",
    );
    expect(updateSocialStatus).toHaveBeenCalledWith("t-fresh", "tiktok", {
      status: "published",
      url: "https://www.tiktok.com/@fluncle/video/awemeFresh",
    });
  });
});
