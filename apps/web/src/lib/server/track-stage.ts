// The derived pipeline stage of a finding — a PURE function of the track's own
// data plus its per-platform social posts. The admin board (the operator's
// pipeline view) groups findings by where they are in the lifecycle and what the
// next action is, without storing any stage column: stage is always re-derived,
// so it can never drift from the underlying record.
//
// The lifecycle (docs/track-lifecycle.md): a finding is ADDED the moment it's on
// Spotify + Telegram (the fast synchronous add); the async agent ENRICHES it
// (audio analysis → enrichment_status "done"); the operator TAGS it on the vibe
// map (vibe_x/vibe_y); the video agent FILMS it (video_url in R2); then it's
// pushed to YOUTUBE and TIKTOK (social_posts). The stage is the FURTHEST point a
// finding has reached, and `blockedOn` names the single next action to advance
// it — which is exactly what the board's worklists ("needs tagging", "needs a
// video", "ready for YouTube", "ready for TikTok") filter on.

import { type SocialPostItem } from "./social";
import { type TrackListItem } from "./tracks";

/**
 * The six pipeline stages, in lifecycle order. A finding sits at the furthest
 * stage it has reached; `STAGE_ORDER` is the canonical ordering for sorting,
 * progress strips, and "is past stage X" comparisons.
 */
export const STAGE_ORDER = ["added", "enriched", "tagged", "filmed", "youtube", "tiktok"] as const;

export type Stage = (typeof STAGE_ORDER)[number];

/**
 * The next action that advances a finding, keyed by the stage it's blocked at.
 * `null` means the finding has reached the end of the pipeline (live on both
 * platforms) — nothing is blocking it. The labels are the worklist names the
 * board groups by, in Fluncle's quiet operator register.
 */
export type BlockedOn =
  | "add to Spotify + Telegram"
  | "needs enrichment"
  | "needs tagging"
  | "needs a video"
  | "ready for YouTube"
  | "ready for TikTok"
  | null;

export type TrackStage = {
  blockedOn: BlockedOn;
  stage: Stage;
};

/** The subset of a finding the stage model reads — keeps the fn easy to unit-test. */
export type StageInput = Pick<
  TrackListItem,
  "addedToSpotify" | "postedToTelegram" | "enrichmentStatus" | "vibeX" | "vibeY" | "videoUrl"
> & {
  /** This finding's per-platform social posts (from listSocialPostsForTracks). */
  posts?: SocialPostItem[];
};

/** A platform post counts as "done" once it's pushed — a draft, scheduled, or live. */
const PUBLISHED_OR_PENDING = new Set(["draft", "scheduled", "published"]);

function hasPost(posts: SocialPostItem[] | undefined, platform: string): boolean {
  return Boolean(
    posts?.some((post) => post.platform === platform && PUBLISHED_OR_PENDING.has(post.status)),
  );
}

/**
 * Derive a finding's pipeline stage + next action from its data alone. Pure: no
 * I/O, no clock. The order of checks walks the lifecycle backwards from the end,
 * so a finding always reports the FURTHEST stage it has reached and the single
 * action that would move it forward.
 */
export function trackStage(track: StageInput): TrackStage {
  const onSpotifyAndTelegram = track.addedToSpotify && track.postedToTelegram;

  // Not fully added yet — the synchronous add hasn't landed on both surfaces.
  // (At current scale every listed finding is already added; this keeps the fn
  // total and honest if a half-added record ever appears.)
  if (!onSpotifyAndTelegram) {
    return { blockedOn: "add to Spotify + Telegram", stage: "added" };
  }

  const enriched = track.enrichmentStatus === "done";
  const tagged = track.vibeX !== undefined && track.vibeY !== undefined;
  const filmed = Boolean(track.videoUrl);
  const onYouTube = hasPost(track.posts, "youtube");
  const onTikTok = hasPost(track.posts, "tiktok");

  // Live on both platforms — the end of the pipeline, nothing blocking.
  if (onYouTube && onTikTok) {
    return { blockedOn: null, stage: "tiktok" };
  }

  // On YouTube but not TikTok → the next action is the TikTok push.
  if (onYouTube) {
    return { blockedOn: "ready for TikTok", stage: "youtube" };
  }

  // On TikTok but not YouTube → still report the furthest platform reached
  // (tiktok), and the next action is the YouTube post.
  if (onTikTok) {
    return { blockedOn: "ready for YouTube", stage: "tiktok" };
  }

  // Has a video but no platform pushes yet → ready to start publishing.
  if (filmed) {
    return { blockedOn: "ready for YouTube", stage: "filmed" };
  }

  // Tagged but no video yet → the video agent's queue.
  if (tagged) {
    return { blockedOn: "needs a video", stage: "tagged" };
  }

  // Enriched but unplaced → the tagging tool's queue.
  if (enriched) {
    return { blockedOn: "needs tagging", stage: "enriched" };
  }

  // Added, awaiting the async enrichment agent.
  return { blockedOn: "needs enrichment", stage: "added" };
}
