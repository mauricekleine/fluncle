// The derived pipeline stage of a finding — a PURE function of the track's own
// data plus its per-platform social posts. The admin board (the operator's
// pipeline view) groups findings by where they are in the lifecycle and what the
// next action is, without storing any stage column: stage is always re-derived,
// so it can never drift from the underlying record.
//
// The lifecycle: a finding is ADDED the moment it's on
// Spotify + Telegram (the fast synchronous add); the async agent ENRICHES it
// (audio analysis → enrichment_status "done"); the video agent FILMS it
// (video_url in R2); then it's pushed to YOUTUBE and TIKTOK (social_posts). The
// stage is the FURTHEST point a finding has reached, and `blockedOn` names the
// single next action to advance it — which is exactly what the board's worklists
// ("needs a video", "ready for YouTube", "ready for TikTok") filter on. (The old
// operator vibe-TAGGING stage is gone with the vibe map — galaxy placement is the
// cluster engine's job now and gates nothing in this pipeline.)

import { isStaleTikTokDraft } from "@fluncle/contracts/util";
import { type SocialPostItem } from "./social";
import { type TrackListItem } from "./tracks";

/**
 * The five pipeline stages, in lifecycle order. A finding sits at the furthest
 * stage it has reached; `STAGE_ORDER` is the canonical ordering for sorting,
 * progress strips, and "is past stage X" comparisons.
 */
export const STAGE_ORDER = ["added", "enriched", "filmed", "youtube", "tiktok"] as const;

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
  "addedToSpotify" | "postedToTelegram" | "enrichmentStatus" | "videoUrl"
> & {
  /** This finding's per-platform social posts (from listSocialPostsForTracks). */
  posts?: SocialPostItem[];
};

/** A platform post counts as "done" once it's pushed — a draft, scheduled, or live. */
const PUBLISHED_OR_PENDING = new Set(["draft", "scheduled", "published"]);

// A pushed post counts as "gone out" — EXCEPT a TikTok inbox draft that has sat past
// TikTok's 24h window, which has almost certainly bounced (Postiz reports the push a
// success, so the row stays `draft` forever). A stale draft re-opens the finding into
// the "ready for TikTok" worklist rather than reading as posted; the shared rule
// (`isStaleTikTokDraft`) is the one source of that 24h cutoff.
function hasPost(posts: SocialPostItem[] | undefined, platform: string, now: number): boolean {
  return Boolean(
    posts?.some(
      (post) =>
        post.platform === platform &&
        PUBLISHED_OR_PENDING.has(post.status) &&
        !isStaleTikTokDraft(post, now),
    ),
  );
}

/**
 * Derive a finding's pipeline stage + next action from its data alone. Pure over the
 * record + an injected clock (`now`, defaulting to the wall clock): the only time
 * dependence is the TikTok stale-draft cutoff, so tests pin it deterministically. The
 * order of checks walks the lifecycle backwards from the end, so a finding always
 * reports the FURTHEST stage it has reached and the single action that would move it
 * forward.
 */
export function trackStage(track: StageInput, now: number = Date.now()): TrackStage {
  const onSpotifyAndTelegram = track.addedToSpotify && track.postedToTelegram;

  // Not fully added yet — the synchronous add hasn't landed on both surfaces.
  // (At current scale every listed finding is already added; this keeps the fn
  // total and honest if a half-added record ever appears.)
  if (!onSpotifyAndTelegram) {
    return { blockedOn: "add to Spotify + Telegram", stage: "added" };
  }

  const enriched = track.enrichmentStatus === "done";
  const filmed = Boolean(track.videoUrl);
  const onYouTube = hasPost(track.posts, "youtube", now);
  const onTikTok = hasPost(track.posts, "tiktok", now);

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

  // Enriched but no video yet → the video agent's queue.
  if (enriched) {
    return { blockedOn: "needs a video", stage: "enriched" };
  }

  // Added, awaiting the async enrichment agent.
  return { blockedOn: "needs enrichment", stage: "added" };
}
