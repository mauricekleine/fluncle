import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const isPublishAdvancePaused = vi.fn();
const setPublishAdvancePaused = vi.fn();
const advanceCandidates = vi.fn();
const bundleGaps = vi.fn();

vi.mock("./publish-advance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./publish-advance")>();

  return {
    ...actual,
    advanceCandidates: (...a: unknown[]) => advanceCandidates(...a),
    bundleGaps: (...a: unknown[]) => bundleGaps(...a),
    isPublishAdvancePaused: (...a: unknown[]) => isPublishAdvancePaused(...a),
    setPublishAdvancePaused: (...a: unknown[]) => setPublishAdvancePaused(...a),
  };
});

const claimPost = vi.fn();
const countPushesSince = vi.fn();
const countTikTokInboxDrafts = vi.fn();
const hasPostAwaitingUrl = vi.fn();
const upsertPost = vi.fn();
const recordPostUrl = vi.fn();

vi.mock("./social", () => ({
  claimPost: (...a: unknown[]) => claimPost(...a),
  countPushesSince: (...a: unknown[]) => countPushesSince(...a),
  countTikTokInboxDrafts: (...a: unknown[]) => countTikTokInboxDrafts(...a),
  hasPostAwaitingUrl: (...a: unknown[]) => hasPostAwaitingUrl(...a),
  isUrlClaimedByOtherTrack: vi.fn(),
  listPostsAwaitingUrl: vi.fn(async () => []),
  listSocialPosts: vi.fn(async () => []),
  recordPostUrl: (...a: unknown[]) => recordPostUrl(...a),
  updateSocialStatus: vi.fn(),
  upsertPost: (...a: unknown[]) => upsertPost(...a),
}));

const pushTikTokDraft = vi.fn();
const pushYouTubeShort = vi.fn();
const resolveSocialUrl = vi.fn();
const postizSetReleaseId = vi.fn();

vi.mock("./postiz", () => ({
  postizSetReleaseId: (...a: unknown[]) => postizSetReleaseId(...a),
  pushTikTokDraft: (...a: unknown[]) => pushTikTokDraft(...a),
  pushYouTubeShort: (...a: unknown[]) => pushYouTubeShort(...a),
  resolveSocialUrl: (...a: unknown[]) => resolveSocialUrl(...a),
}));

const readCaptions = vi.fn();

vi.mock("./captions", () => ({
  readCaptions: (...a: unknown[]) => readCaptions(...a),
}));

vi.mock("./mentions", () => ({
  captionForPlatform: (_t: string, _p: string, caption: string) => caption,
}));

const ADVANCE = "/admin/social/publish/advance";
const STATE = "/admin/social/publish/advance/state";

const READY = {
  logId: "039.8.7J",
  pending: ["youtube", "tiktok"],
  title: "Netsky — Escape",
  trackId: "t1",
  videoSquaredAt: "2026-07-11T10:00:00.000Z",
};

beforeAll(setAdminTokenEnv);

warmOrpcRouter();

beforeEach(() => {
  vi.clearAllMocks();

  isPublishAdvancePaused.mockResolvedValue(false);
  advanceCandidates.mockResolvedValue([READY]);
  bundleGaps.mockResolvedValue([]);
  readCaptions.mockResolvedValue({ "039.8.7J": "a caption from the bundle" });
  countPushesSince.mockResolvedValue(0);
  countTikTokInboxDrafts.mockResolvedValue(0);
  hasPostAwaitingUrl.mockResolvedValue(false);
  claimPost.mockResolvedValue(true);
  pushYouTubeShort.mockResolvedValue({ postId: "yt-1" });
  pushTikTokDraft.mockResolvedValue({ postId: "tt-1" });
  resolveSocialUrl.mockResolvedValue(null);
});

describe("oRPC advance_publish_queue — the tier", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");

    expect((await handleOrpc(req(ADVANCE, "POST", undefined, {})))?.status).toBe(401);
  });

  it("lets the BOX (agent token) tick the advance — it holds no Postiz key, it triggers", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(pushYouTubeShort).toHaveBeenCalledTimes(1);
  });

  it("403s the agent on the KILL SWITCH — the box may tick it, never turn it on", async () => {
    const { handleOrpc } = await import("./orpc");

    expect((await handleOrpc(req(STATE, "PUT", AGENT_TOKEN, { paused: false })))?.status).toBe(403);
    expect(setPublishAdvancePaused).not.toHaveBeenCalled();
  });

  it("lets the OPERATOR flip the kill switch", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(STATE, "PUT", OPERATOR_TOKEN, { paused: true }));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, paused: true });
    expect(setPublishAdvancePaused).toHaveBeenCalledWith(true);
  });
});

describe("SAFETY: the kill switch", () => {
  it("no-ops a paused tick — nothing selected, nothing pushed", async () => {
    isPublishAdvancePaused.mockResolvedValue(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      candidates: 0,
      failed: [],
      held: [],
      ok: true,
      paused: true,
      pushed: [],
    });

    expect(advanceCandidates).not.toHaveBeenCalled();
    expect(claimPost).not.toHaveBeenCalled();
    expect(pushYouTubeShort).not.toHaveBeenCalled();
    expect(pushTikTokDraft).not.toHaveBeenCalled();
  });
});

describe("SAFETY: never half-rendered", () => {
  it("HOLDS a finding whose bundle is incomplete, and names the missing files", async () => {
    bundleGaps.mockResolvedValue(["footage.social.mp4", "render.json"]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {}));
    const body = (await readJson(response)) as {
      held: { missing?: string[]; platform: string; reason: string }[];
      pushed: unknown[];
    };

    expect(body.pushed).toEqual([]);
    expect(body.held).toEqual([
      {
        missing: ["footage.social.mp4", "render.json"],
        platform: "youtube",
        reason: "bundle_incomplete",
        trackId: "t1",
      },
      {
        missing: ["footage.social.mp4", "render.json"],
        platform: "tiktok",
        reason: "bundle_incomplete",
        trackId: "t1",
      },
    ]);

    expect(claimPost).not.toHaveBeenCalled();
    expect(pushYouTubeShort).not.toHaveBeenCalled();
    expect(pushTikTokDraft).not.toHaveBeenCalled();
  });

  it("HOLDS a finding with an empty caption (no caption-less Short goes on the channel)", async () => {
    readCaptions.mockResolvedValue({});

    const { handleOrpc } = await import("./orpc");
    const body = (await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))) as {
      held: { reason: string }[];
      pushed: unknown[];
    };

    expect(body.pushed).toEqual([]);
    expect(body.held.map((held) => held.reason)).toEqual(["no_caption", "no_caption"]);
    expect(claimPost).not.toHaveBeenCalled();
  });
});

describe("SAFETY: never twice", () => {
  it("two OVERLAPPING ticks upload exactly ONCE (the claim arbitrates)", async () => {
    const claimed = new Set<string>();
    claimPost.mockImplementation(async (trackId: string, platform: string) => {
      const key = `${trackId}:${platform}`;

      if (claimed.has(key)) {
        return false;
      }

      claimed.add(key);

      return true;
    });

    const { handleOrpc } = await import("./orpc");

    const [first, second] = await Promise.all([
      handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})),
      handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})),
    ]);

    const bodies = [
      (await readJson(first)) as { pushed: unknown[] },
      (await readJson(second)) as { pushed: unknown[] },
    ];

    expect(pushYouTubeShort).toHaveBeenCalledTimes(1);
    expect(pushTikTokDraft).toHaveBeenCalledTimes(1);
    expect(bodies.reduce((total, body) => total + body.pushed.length, 0)).toBe(2);

    expect(claimPost).toHaveBeenCalledTimes(4);
  });

  it("does not push when the claim is LOST (someone else already has the row)", async () => {
    claimPost.mockResolvedValue(false);

    const { handleOrpc } = await import("./orpc");
    const body = (await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))) as {
      pushed: unknown[];
    };

    expect(body.pushed).toEqual([]);
    expect(pushYouTubeShort).not.toHaveBeenCalled();
    expect(pushTikTokDraft).not.toHaveBeenCalled();
    expect(upsertPost).not.toHaveBeenCalled();
  });
});

describe("the advance itself", () => {
  it("pushes a public YouTube Short and a TikTok inbox draft, and records both", async () => {
    resolveSocialUrl.mockResolvedValue({
      nativeId: "vid-1",
      url: "https://www.youtube.com/shorts/vid-1",
    });

    const { handleOrpc } = await import("./orpc");
    const body = (await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))) as {
      candidates: number;
      pushed: { platform: string; status: string }[];
    };

    expect(body.candidates).toBe(1);
    expect(body.pushed).toEqual([
      {
        externalId: "yt-1",
        logId: "039.8.7J",
        platform: "youtube",
        status: "published",
        trackId: "t1",
      },
      { externalId: "tt-1", logId: "039.8.7J", platform: "tiktok", status: "draft", trackId: "t1" },
    ]);

    expect(pushYouTubeShort).toHaveBeenCalledWith({
      description: "a caption from the bundle",
      title: "Netsky — Escape",
      videoUrl: "https://found.fluncle.com/039.8.7J/footage.social.mp4",
    });

    const tikTokUrl = String(pushTikTokDraft.mock.calls[0]?.[0]?.videoUrl);
    expect(tikTokUrl).toContain("audio=false");
    expect(tikTokUrl).toContain("footage.social.mp4");

    expect(upsertPost).toHaveBeenCalledWith("t1", "youtube", "published", "yt-1");
    expect(upsertPost).toHaveBeenCalledWith("t1", "tiktok", "draft", "tt-1");
    expect(recordPostUrl).toHaveBeenCalledWith(
      "t1",
      "youtube",
      "https://www.youtube.com/shorts/vid-1",
    );
    expect(postizSetReleaseId).toHaveBeenCalledWith("yt-1", "vid-1");
  });

  it("reports an empty tick honestly", async () => {
    advanceCandidates.mockResolvedValue([]);

    const { handleOrpc } = await import("./orpc");

    expect(await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))).toEqual({
      candidates: 0,
      failed: [],
      held: [],
      ok: true,
      paused: false,
      pushed: [],
    });
  });
});

describe("SAFETY: fail closed", () => {
  it("leaves a failed push `failed` (the claim row) and still finishes the tick", async () => {
    pushYouTubeShort.mockRejectedValue(new Error("Postiz 502"));

    const { handleOrpc } = await import("./orpc");
    const body = (await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))) as {
      failed: { platform: string; trackId: string }[];
      pushed: { platform: string }[];
    };

    expect(body.failed).toEqual([{ platform: "youtube", trackId: "t1" }]);

    expect(body.pushed.map((push) => push.platform)).toEqual(["tiktok"]);

    expect(upsertPost).not.toHaveBeenCalledWith(
      "t1",
      "youtube",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("the caps", () => {
  it("holds everything once the rolling-24h push budget is spent", async () => {
    countPushesSince.mockResolvedValue(6);

    const { handleOrpc } = await import("./orpc");
    const body = (await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))) as {
      held: { reason: string }[];
      pushed: unknown[];
    };

    expect(body.pushed).toEqual([]);
    expect(body.held.map((held) => held.reason)).toEqual(["daily_cap", "daily_cap"]);
    expect(claimPost).not.toHaveBeenCalled();
  });

  it("holds YouTube while a prior Short is still awaiting its URL, and still drafts TikTok", async () => {
    hasPostAwaitingUrl.mockResolvedValue(true);

    const { handleOrpc } = await import("./orpc");
    const body = (await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))) as {
      held: { platform: string; reason: string }[];
      pushed: { platform: string }[];
    };

    expect(body.held).toEqual([
      { platform: "youtube", reason: "youtube_url_pending", trackId: "t1" },
    ]);
    expect(body.pushed.map((push) => push.platform)).toEqual(["tiktok"]);
    expect(pushYouTubeShort).not.toHaveBeenCalled();
  });

  it("holds TikTok once the inbox is at its 5-draft ceiling, and still posts the Short", async () => {
    countTikTokInboxDrafts.mockResolvedValue(5);

    const { handleOrpc } = await import("./orpc");
    const body = (await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))) as {
      held: { platform: string; reason: string }[];
      pushed: { platform: string }[];
    };

    expect(body.held).toEqual([{ platform: "tiktok", reason: "tiktok_inbox_full", trackId: "t1" }]);
    expect(body.pushed.map((push) => push.platform)).toEqual(["youtube"]);
    expect(pushTikTokDraft).not.toHaveBeenCalled();
  });
});
