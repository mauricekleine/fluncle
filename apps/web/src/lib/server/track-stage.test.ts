import { describe, expect, it } from "vitest";
import { type SocialPostItem } from "./social";
import { type StageInput, STAGE_ORDER, trackStage } from "./track-stage";

// A fully-added finding: on Spotify + Telegram, nothing else. The lifecycle
// checks layer enrichment / placement / video / posts on top of this base.
const added: StageInput = {
  addedToSpotify: true,
  enrichmentStatus: "pending",
  postedToTelegram: true,
};

// A fixed clock for the publishing-stage cases, where the TikTok stale-draft
// cutoff makes `trackStage` clock-dependent. `updatedAt` defaults FRESH (2h before
// NOW) so a draft reads as still in the inbox; pass an older stamp to exercise the
// bounced-draft path.
const NOW = Date.parse("2026-07-06T20:00:00.000Z");

function post(
  platform: string,
  status: string,
  updatedAt = "2026-07-06T18:00:00.000Z",
): SocialPostItem {
  return {
    createdAt: "2026-06-01T00:00:00.000Z",
    platform,
    status,
    updatedAt,
  };
}

describe("trackStage — base lifecycle", () => {
  it("a half-added finding (not yet on both surfaces) reports `added` blocked on the add", () => {
    expect(trackStage({ ...added, addedToSpotify: false })).toEqual({
      blockedOn: "add to Spotify + Telegram",
      stage: "added",
    });
    expect(trackStage({ ...added, postedToTelegram: false })).toEqual({
      blockedOn: "add to Spotify + Telegram",
      stage: "added",
    });
  });

  it("added but not enriched → `added`, needs enrichment", () => {
    expect(trackStage(added)).toEqual({ blockedOn: "needs enrichment", stage: "added" });
  });

  it("a failed enrichment still counts as not-enriched → needs enrichment", () => {
    expect(trackStage({ ...added, enrichmentStatus: "failed" })).toEqual({
      blockedOn: "needs enrichment",
      stage: "added",
    });
  });

  it("enriched (done) but unplaced → `enriched`, needs tagging", () => {
    expect(trackStage({ ...added, enrichmentStatus: "done" })).toEqual({
      blockedOn: "needs tagging",
      stage: "enriched",
    });
  });

  it("tagged (vibe_x/vibe_y set) but no video → `tagged`, needs a video", () => {
    expect(trackStage({ ...added, enrichmentStatus: "done", vibeX: -0.3, vibeY: 0.5 })).toEqual({
      blockedOn: "needs a video",
      stage: "tagged",
    });
  });

  it("a zero coordinate still counts as placed (0 is a valid vibe value)", () => {
    expect(trackStage({ ...added, enrichmentStatus: "done", vibeX: 0, vibeY: 0 })).toEqual({
      blockedOn: "needs a video",
      stage: "tagged",
    });
  });

  it("filmed (video_url set) but unpushed → `filmed`, ready for YouTube", () => {
    expect(
      trackStage({
        ...added,
        enrichmentStatus: "done",
        vibeX: 0.2,
        vibeY: -0.1,
        videoUrl: "https://found.fluncle.com/241.7.3A/footage.mp4",
      }),
    ).toEqual({ blockedOn: "ready for YouTube", stage: "filmed" });
  });
});

describe("trackStage — publishing stages", () => {
  const filmed: StageInput = {
    ...added,
    enrichmentStatus: "done",
    vibeX: 0.2,
    vibeY: -0.1,
    videoUrl: "https://found.fluncle.com/241.7.3A/footage.mp4",
  };

  it("on YouTube but not TikTok → `youtube`, ready for TikTok", () => {
    expect(trackStage({ ...filmed, posts: [post("youtube", "published")] }, NOW)).toEqual({
      blockedOn: "ready for TikTok",
      stage: "youtube",
    });
  });

  it("a FRESH TikTok draft (in the inbox, under 24h) counts as pushed → reaches `tiktok`", () => {
    expect(trackStage({ ...filmed, posts: [post("tiktok", "draft")] }, NOW)).toEqual({
      blockedOn: "ready for YouTube",
      stage: "tiktok",
    });
  });

  it("a STALE TikTok draft (past 24h, likely bounced) re-opens the finding as ready for TikTok", () => {
    // The live bug: TikTok async-bounces the draft, Postiz still reports success, the
    // row stays `draft` — so a bounced draft used to read as posted forever. Past 24h
    // it must re-surface in the "ready for TikTok" worklist.
    expect(
      trackStage(
        {
          ...filmed,
          posts: [
            post("youtube", "published"),
            post("tiktok", "draft", "2026-07-05T10:00:00.000Z"),
          ],
        },
        NOW,
      ),
    ).toEqual({ blockedOn: "ready for TikTok", stage: "youtube" });
  });

  it("a STALE TikTok draft with no other push falls back to `filmed` (nothing has gone out)", () => {
    expect(
      trackStage({ ...filmed, posts: [post("tiktok", "draft", "2026-07-05T10:00:00.000Z")] }, NOW),
    ).toEqual({ blockedOn: "ready for YouTube", stage: "filmed" });
  });

  it("live on both platforms → `tiktok`, nothing blocking", () => {
    expect(
      trackStage(
        {
          ...filmed,
          posts: [post("youtube", "published"), post("tiktok", "published")],
        },
        NOW,
      ),
    ).toEqual({ blockedOn: null, stage: "tiktok" });
  });

  it("a failed push does NOT count as pushed → stays `filmed`", () => {
    expect(trackStage({ ...filmed, posts: [post("youtube", "failed")] }, NOW)).toEqual({
      blockedOn: "ready for YouTube",
      stage: "filmed",
    });
  });

  it("posts present but for an unrelated platform are ignored", () => {
    expect(trackStage({ ...filmed, posts: [post("instagram", "published")] }, NOW)).toEqual({
      blockedOn: "ready for YouTube",
      stage: "filmed",
    });
  });
});

describe("STAGE_ORDER", () => {
  it("is the canonical six-stage lifecycle ordering", () => {
    expect(STAGE_ORDER).toEqual(["added", "enriched", "tagged", "filmed", "youtube", "tiktok"]);
  });

  it("every reachable stage is a member of STAGE_ORDER", () => {
    const samples: StageInput[] = [
      { ...added, addedToSpotify: false },
      added,
      { ...added, enrichmentStatus: "done" },
      { ...added, enrichmentStatus: "done", vibeX: 0, vibeY: 0 },
      { ...added, enrichmentStatus: "done", vibeX: 0, vibeY: 0, videoUrl: "x" },
      {
        ...added,
        enrichmentStatus: "done",
        posts: [post("youtube", "published")],
        vibeX: 0,
        vibeY: 0,
        videoUrl: "x",
      },
    ];

    for (const sample of samples) {
      expect(STAGE_ORDER).toContain(trackStage(sample).stage);
    }
  });
});
