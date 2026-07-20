import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, req, setAdminTokenEnv } from "./orpc-test-kit";

// The render → publish AUTO-ADVANCE, driven end-to-end through `handleOrpc`.
//
// This is the op that lets the machine publish to Fluncle's PUBLIC YouTube channel with no
// human in the loop, so the tests here are not "does it work" — they are the safety
// argument, each property proved rather than asserted:
//
//   1. NEVER TWICE     — two overlapping ticks that both select the same finding upload
//                        ONCE. The claim is atomic and taken before any call to Postiz.
//   2. NEVER HALF-DONE — a finding whose bundle is incomplete (or whose caption is empty)
//                        is HELD, never advanced.
//   3. THE KILL SWITCH — a paused tick reads nothing and pushes nothing.
//
// Plus the tier (the box's agent token may TICK the advance; only the operator may TURN IT
// ON) and the fail-closed behaviour (a failed push is left `failed`, never retried).
//
// The store (`./publish-advance`, `./social`), Postiz, and the caption read are mocked —
// the handler's job is the orchestration, and the primitives underneath it are pinned in
// ./publish-advance.test.ts.

const isPublishAdvancePaused = vi.fn();
const setPublishAdvancePaused = vi.fn();
const advanceCandidates = vi.fn();
const bundleGaps = vi.fn();

vi.mock("./publish-advance", async (importOriginal) => {
  // Keep the real constants (the caps, the platforms) — only the DB/network reads are faked.
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

// Mention injection is pinned in mentions.test.ts; here it passes the caption through so
// the advance tests stay about the safety argument (claim / gates / caps) and never reach
// the DB through `captionForPlatform`.
vi.mock("./mentions", () => ({
  captionForPlatform: (_t: string, _p: string, caption: string) => caption,
}));

const ADVANCE = "/admin/social/publish/advance";
const STATE = "/admin/social/publish/advance/state";

// One READY finding: rendered with both masters, settled, nothing pushed yet.
const READY = {
  logId: "039.8.7J",
  pending: ["youtube", "tiktok"],
  title: "Netsky — Escape",
  trackId: "t1",
  videoSquaredAt: "2026-07-11T10:00:00.000Z",
};

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  vi.clearAllMocks();
  // The default world: the switch is ON (an operator resumed it), one ready finding, a
  // complete bundle, a real caption, no caps hit, and every claim won.
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

// ── The tier ─────────────────────────────────────────────────────────────────
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

// ── SAFETY 1 — the kill switch stops it ──────────────────────────────────────
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

    // The switch is read FIRST: a paused tick does not even LOOK at the queue.
    expect(advanceCandidates).not.toHaveBeenCalled();
    expect(claimPost).not.toHaveBeenCalled();
    expect(pushYouTubeShort).not.toHaveBeenCalled();
    expect(pushTikTokDraft).not.toHaveBeenCalled();
  });
});

// ── SAFETY 2 — never publish a half-rendered finding ─────────────────────────
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

    // The gate runs BEFORE the claim, so a half-rendered finding is not even claimed — it
    // stays fully eligible for a later tick once the render lands.
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

// ── SAFETY 3 — never twice ───────────────────────────────────────────────────
describe("SAFETY: never twice", () => {
  it("two OVERLAPPING ticks upload exactly ONCE (the claim arbitrates)", async () => {
    // The real guarantee is the (track, platform) unique index: both ticks reach the
    // insert, one gets the row. Model that here — the claim succeeds the FIRST time a
    // (track, platform) pair is seen and fails forever after, exactly as
    // `insert … on conflict do nothing` behaves.
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

    // Both ticks select the same finding (the loser's `advanceCandidates` read raced ahead
    // of the winner's claim — the exact interleaving the claim exists for).
    const [first, second] = await Promise.all([
      handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})),
      handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})),
    ]);

    const bodies = [
      (await readJson(first)) as { pushed: unknown[] },
      (await readJson(second)) as { pushed: unknown[] },
    ];

    // ONE upload per platform across BOTH ticks — the finding never double-publishes.
    expect(pushYouTubeShort).toHaveBeenCalledTimes(1);
    expect(pushTikTokDraft).toHaveBeenCalledTimes(1);
    expect(bodies.reduce((total, body) => total + body.pushed.length, 0)).toBe(2);

    // And the claim was taken before the network, not after it: 4 claim attempts (2 ticks ×
    // 2 platforms), only 2 of which won.
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

// ── The happy path + the per-platform contract ───────────────────────────────
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

    // YouTube takes the portrait baked-text cut AS-IS (its own audio); the title carries.
    expect(pushYouTubeShort).toHaveBeenCalledWith({
      description: "a caption from the bundle",
      title: "Netsky — Escape",
      videoUrl: "https://found.fluncle.com/039.8.7J/footage.social.mp4",
    });

    // TikTok takes it AUDIO-STRIPPED (an `audio=false` Media Transformation), so the
    // operator attaches the licensed sound in-app.
    const tikTokUrl = String(pushTikTokDraft.mock.calls[0]?.[0]?.videoUrl);
    expect(tikTokUrl).toContain("audio=false");
    expect(tikTokUrl).toContain("footage.social.mp4");

    // The rows land with their real status, and the live YouTube URL is captured inline.
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

// ── FAIL CLOSED — a failure stops, visibly, and is never retried by the machine ─
describe("SAFETY: fail closed", () => {
  it("leaves a failed push `failed` (the claim row) and still finishes the tick", async () => {
    pushYouTubeShort.mockRejectedValue(new Error("Postiz 502"));

    const { handleOrpc } = await import("./orpc");
    const body = (await readJson(await handleOrpc(req(ADVANCE, "POST", AGENT_TOKEN, {})))) as {
      failed: { platform: string; trackId: string }[];
      pushed: { platform: string }[];
    };

    expect(body.failed).toEqual([{ platform: "youtube", trackId: "t1" }]);
    // One bad platform never burns the other.
    expect(body.pushed.map((push) => push.platform)).toEqual(["tiktok"]);

    // NOTHING is written back for the failed leg: the CLAIM already wrote the row as
    // `failed`, which is the honest end state. The finding keeps its `post-youtube` row in
    // the /admin attention queue, and the advance will never pick it up again (it only
    // selects platforms with NO row) — the operator owns the retry.
    expect(upsertPost).not.toHaveBeenCalledWith(
      "t1",
      "youtube",
      expect.anything(),
      expect.anything(),
    );
  });
});

// ── The bounds ───────────────────────────────────────────────────────────────
describe("the caps", () => {
  it("holds everything once the rolling-24h push budget is spent", async () => {
    countPushesSince.mockResolvedValue(6); // ADVANCE_DAILY_PUSH_CAP

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
