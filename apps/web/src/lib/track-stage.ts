import { isStaleTikTokDraft } from "@fluncle/contracts/util";
import { type SocialPostItem } from "./server/social";
import { type TrackListItem } from "./server/tracks";

export const STAGE_ORDER = ["added", "enriched", "filmed", "youtube", "tiktok"] as const;

export type Stage = (typeof STAGE_ORDER)[number];

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

export type StageInput = Pick<
  TrackListItem,
  "addedToSpotify" | "postedToTelegram" | "enrichmentStatus" | "videoUrl"
> & {
  posts?: SocialPostItem[];
};

const PUBLISHED_OR_PENDING = new Set(["draft", "scheduled", "published"]);

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

export function trackStage(track: StageInput, now: number = Date.now()): TrackStage {
  const onSpotifyAndTelegram = track.addedToSpotify && track.postedToTelegram;

  if (!onSpotifyAndTelegram) {
    return { blockedOn: "add to Spotify + Telegram", stage: "added" };
  }

  const enriched = track.enrichmentStatus === "done";
  const filmed = Boolean(track.videoUrl);
  const onYouTube = hasPost(track.posts, "youtube", now);
  const onTikTok = hasPost(track.posts, "tiktok", now);

  if (onYouTube && onTikTok) {
    return { blockedOn: null, stage: "tiktok" };
  }

  if (onYouTube) {
    return { blockedOn: "ready for TikTok", stage: "youtube" };
  }

  if (onTikTok) {
    return { blockedOn: "ready for YouTube", stage: "tiktok" };
  }

  if (filmed) {
    return { blockedOn: "ready for YouTube", stage: "filmed" };
  }

  if (enriched) {
    return { blockedOn: "needs a video", stage: "enriched" };
  }

  return { blockedOn: "needs enrichment", stage: "added" };
}
