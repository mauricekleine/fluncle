import { ORPCError } from "@orpc/server";
import { trackMedia, videoAudioStripped, videoVersion } from "../../media";
import { readCaptions } from "../captions";
import { logEvent } from "../log";
import { captionForPlatform } from "../mentions";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { postizSetReleaseId, pushTikTokDraft, pushYouTubeShort, resolveSocialUrl } from "../postiz";
import { getSocialMetricsBoard } from "../reach-board";
import { recordSocialMetrics } from "../social-metrics";
import {
  ADVANCE_DAILY_PUSH_CAP,
  ADVANCE_PER_TICK_CAP,
  type AdvanceHeld,
  type AdvancePlatform,
  type AdvancePush,
  advanceCandidates,
  bundleGaps,
  DAY_MS,
  isPublishAdvancePaused,
  setPublishAdvancePaused,
  TIKTOK_INBOX_DRAFT_CAP,
} from "../publish-advance";
import {
  claimPost,
  countPushesSince,
  countTikTokInboxDrafts,
  hasPostAwaitingUrl,
  isUrlClaimedByOtherTrack,
  listPostsAwaitingUrl,
  listSocialPosts,
  recordPostUrl,
  type SocialStatusUpdate,
  updateSocialStatus,
  upsertPost,
} from "../social";
import { parseLimit, requireTrack, type Implementer, toFault } from "./_shared";

const SUPPORTED = new Set(["tiktok", "youtube"]);

type PushTarget = {
  logId: string;
  title: string;
  trackId: string;

  videoSquaredAt?: string;
};

async function pushToPlatform(
  target: PushTarget,
  platform: AdvancePlatform,
  caption: string,
): Promise<{ postId: string; status: "draft" | "published" }> {
  const media = trackMedia(target.logId);
  const social = target.videoSquaredAt ? media.socialVideoUrl : media.videoUrl;

  if (platform === "tiktok") {
    const silent = target.videoSquaredAt
      ? videoAudioStripped(social, videoVersion(target.videoSquaredAt))
      : social.replace(/footage\.mp4$/, "footage-silent.mp4");
    const { postId } = await pushTikTokDraft({ caption, videoUrl: silent });

    return { postId, status: "draft" };
  }

  const { postId } = await pushYouTubeShort({
    description: caption,
    title: target.title,
    videoUrl: social,
  });

  return { postId, status: "published" };
}

async function linkYouTubeUrl(trackId: string, postId: string): Promise<void> {
  const resolved = await resolveSocialUrl(postId, "youtube");

  if (resolved) {
    await recordPostUrl(trackId, "youtube", resolved.url);
    await postizSetReleaseId(postId, resolved.nativeId);
  }
}

export function adminSocialHandlers(os: Implementer) {
  const listTrackSocialHandler = os.list_track_social.use(adminAuth).handler(async ({ input }) => {
    try {
      const idOrLogId = input.trackId;
      const track = await requireTrack(idOrLogId);

      const posts = await listSocialPosts(track.trackId);

      return { ok: true as const, posts, trackId: track.trackId };
    } catch (error) {
      throw toFault(error);
    }
  });

  const updateTrackSocialHandler = os.update_track_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const platform = input.platform;
        const status = input.status;

        if (status !== "scheduled" && status !== "published" && status !== "failed") {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "bad_status",
              apiMessage: "status must be scheduled, published, or failed",
            },
            message: "status must be scheduled, published, or failed",
            status: 400,
          });
        }

        if (status === "published" && typeof input.url !== "string") {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "url_required", apiMessage: "Publishing requires the post --url" },
            message: "Publishing requires the post --url",
            status: 400,
          });
        }

        const update: SocialStatusUpdate = { status };

        if (typeof input.url === "string") {
          update.url = input.url;
        }

        if (typeof input.scheduledFor === "string") {
          update.scheduledFor = input.scheduledFor;
        }

        const track = await requireTrack(idOrLogId);

        const updated = await updateSocialStatus(track.trackId, platform, update);

        if (!updated) {
          throw new ORPCError("NOT_FOUND", {
            data: {
              apiCode: "no_post",
              apiMessage: `No ${platform} post for this track; push a draft first`,
            },
            message: `No ${platform} post for this track; push a draft first`,
            status: 404,
          });
        }

        return { ok: true as const, platform, status, trackId: track.trackId };
      } catch (error) {
        throw toFault(error);
      }
    });

  const draftTrackSocialHandler = os.draft_track_social
    .use(adminAuth)
    .handler(async ({ context, input }) => {
      try {
        const idOrLogId = input.trackId;
        const platform = input.platform;

        if (!SUPPORTED.has(platform)) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "unsupported_platform",
              apiMessage: `Unsupported platform: ${platform}`,
            },
            message: `Unsupported platform: ${platform}`,
            status: 400,
          });
        }

        if (platform === "youtube" && context.role !== "operator") {
          throw new ORPCError("FORBIDDEN", {
            data: { apiCode: "forbidden", apiMessage: "This action requires the operator role" },
            message: "This action requires the operator role",
            status: 403,
          });
        }

        if (platform === "youtube" && (await hasPostAwaitingUrl("youtube"))) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "youtube_url_pending",
              apiMessage:
                "A YouTube post is still awaiting its URL — record it first, then push the next one.",
            },
            message: "A YouTube post is still awaiting its URL — record it first.",
            status: 409,
          });
        }

        const track = await requireTrack(idOrLogId);

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        if (!track.videoUrl) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_video",
              apiMessage: "Track has no video; render + upload it first",
            },
            message: "Track has no video; render + upload it first",
            status: 400,
          });
        }

        const captions = await readCaptions([track.logId]);
        const rawCaption = captions[track.logId] ?? "";
        const mentionPlatform = platform === "tiktok" ? "tiktok" : "youtube";

        const caption = await captionForPlatform(track.trackId, mentionPlatform, rawCaption);

        const { postId, status } = await pushToPlatform(
          {
            logId: track.logId,
            title: track.title,
            trackId: track.trackId,
            ...(track.videoSquaredAt ? { videoSquaredAt: track.videoSquaredAt } : {}),
          },
          platform === "tiktok" ? "tiktok" : "youtube",
          caption,
        );

        await upsertPost(track.trackId, platform, status, postId);

        if (platform === "youtube") {
          await linkYouTubeUrl(track.trackId, postId);
        }

        return {
          externalId: postId,
          ok: true as const,
          platform,
          status,
          trackId: track.trackId,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  const capturePostUrlsHandler = os.capture_post_urls.use(adminAuth).handler(async ({ input }) => {
    try {
      const limit = parseLimit(typeof input.limit === "string" ? input.limit : undefined, 25, 100);
      const pending = await listPostsAwaitingUrl(limit);

      const captured: Array<{ platform: string; trackId: string; url: string }> = [];
      let polled = 0;

      for (const post of pending) {
        polled += 1;

        const resolved = await resolveSocialUrl(post.externalId, post.platform);

        if (!resolved) {
          continue;
        }

        if (await isUrlClaimedByOtherTrack(resolved.url, post.trackId)) {
          continue;
        }

        const recorded = await recordPostUrl(post.trackId, post.platform, resolved.url);

        if (!recorded) {
          continue;
        }

        await postizSetReleaseId(post.externalId, resolved.nativeId);

        if (post.platform === "tiktok" && post.status === "draft") {
          await updateSocialStatus(post.trackId, post.platform, {
            status: "published",
            url: resolved.url,
          });
        }

        captured.push({ platform: post.platform, trackId: post.trackId, url: resolved.url });
      }

      return { captured, ok: true as const, polled };
    } catch (error) {
      throw toFault(error);
    }
  });

  const recordSocialMetricsHandler = os.record_social_metrics.use(adminAuth).handler(async () => {
    try {
      const result = await recordSocialMetrics();

      return {
        budget: result.budget,
        configured: result.configured,
        day: result.day,
        eligible: result.eligible,
        failed: result.failed,
        inserted: result.inserted,
        missing: result.missing,
        ok: true as const,
        polled: result.polled,
        referrals: {
          arrivals: result.referrals.arrivals,
          configured: result.referrals.configured,
          total: result.referrals.total,
        },
        tiktok: {
          configured: result.tiktok.configured,
          failed: result.tiktok.failed,
          fetched: result.tiktok.fetched,
          inserted: result.tiktok.inserted,
          matched: result.tiktok.matched,
          skipped: result.tiktok.skipped,
        },
        youtube: {
          configured: result.youtube.configured,
          failed: result.youtube.failed,
          fetched: result.youtube.fetched,
          inserted: result.youtube.inserted,
          matched: result.youtube.matched,
          skipped: result.youtube.skipped,
        },
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  const advancePublishQueueHandler = os.advance_publish_queue.use(adminAuth).handler(async () => {
    try {
      if (await isPublishAdvancePaused()) {
        return {
          candidates: 0,
          failed: [],
          held: [],
          ok: true as const,
          paused: true,
          pushed: [],
        };
      }

      const now = Date.now();

      const candidates = await advanceCandidates({ limit: ADVANCE_PER_TICK_CAP, nowMs: now });

      const recent = await countPushesSince(new Date(now - DAY_MS).toISOString());
      let budget = Math.max(0, ADVANCE_DAILY_PUSH_CAP - recent);

      const pushed: AdvancePush[] = [];
      const held: AdvanceHeld[] = [];
      const failed: Array<{ platform: AdvancePlatform; trackId: string }> = [];
      const hold = (
        platform: AdvancePlatform,
        reason: AdvanceHeld["reason"],
        trackId: string,
        missing?: string[],
      ) => held.push({ platform, reason, trackId, ...(missing ? { missing } : {}) });

      for (const candidate of candidates) {
        const missing = await bundleGaps(candidate.logId);

        if (missing.length > 0) {
          for (const platform of candidate.pending) {
            hold(platform, "bundle_incomplete", candidate.trackId, missing);
          }

          continue;
        }

        const captions = await readCaptions([candidate.logId]);
        const rawCaption = captions[candidate.logId] ?? "";

        if (!rawCaption) {
          for (const platform of candidate.pending) {
            hold(platform, "no_caption", candidate.trackId);
          }

          continue;
        }

        for (const platform of candidate.pending) {
          if (budget <= 0) {
            hold(platform, "daily_cap", candidate.trackId);
            continue;
          }

          if (platform === "youtube" && (await hasPostAwaitingUrl("youtube"))) {
            hold(platform, "youtube_url_pending", candidate.trackId);
            continue;
          }

          if (platform === "tiktok" && (await countTikTokInboxDrafts()) >= TIKTOK_INBOX_DRAFT_CAP) {
            hold(platform, "tiktok_inbox_full", candidate.trackId);
            continue;
          }

          if (!(await claimPost(candidate.trackId, platform))) {
            continue;
          }

          budget -= 1;

          try {
            const caption = await captionForPlatform(candidate.trackId, platform, rawCaption);
            const { postId, status } = await pushToPlatform(candidate, platform, caption);

            await upsertPost(candidate.trackId, platform, status, postId);

            if (platform === "youtube") {
              await linkYouTubeUrl(candidate.trackId, postId);
            }

            pushed.push({
              externalId: postId,
              logId: candidate.logId,
              platform,
              status,
              trackId: candidate.trackId,
            });
          } catch (error) {
            logEvent("warn", "publish-advance.push-failed", {
              error,
              logId: candidate.logId,
              platform,
            });
            failed.push({ platform, trackId: candidate.trackId });
          }
        }
      }

      return {
        candidates: candidates.length,
        failed,
        held,
        ok: true as const,
        paused: false,
        pushed,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  const setPublishAdvanceHandler = os.set_publish_advance
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await setPublishAdvancePaused(input.paused);

        return { ok: true as const, paused: input.paused };
      } catch (error) {
        throw toFault(error);
      }
    });

  const getSocialMetricsHandler = os.get_social_metrics
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const parsed = input.windowDays ? Number.parseInt(input.windowDays, 10) : undefined;
        const windowDays = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;

        return await getSocialMetricsBoard(windowDays);
      } catch (error) {
        throw toFault(error);
      }
    });

  return {
    advance_publish_queue: advancePublishQueueHandler,
    capture_post_urls: capturePostUrlsHandler,
    draft_track_social: draftTrackSocialHandler,
    get_social_metrics: getSocialMetricsHandler,
    list_track_social: listTrackSocialHandler,
    record_social_metrics: recordSocialMetricsHandler,
    set_publish_advance: setPublishAdvanceHandler,
    update_track_social: updateTrackSocialHandler,
  };
}
