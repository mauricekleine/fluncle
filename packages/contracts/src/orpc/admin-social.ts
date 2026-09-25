import { oc } from "@orpc/contract";
import * as z from "zod";
import { SocialPostItemSchema } from "./_shared";

export const listTrackSocial = oc
  .route({
    method: "GET",
    operationId: "listTrackSocial",
    path: "/admin/tracks/{trackId}/social",
    summary: "List a finding's per-platform publication state",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(
    z.object({
      ok: z.literal(true),
      posts: z.array(SocialPostItemSchema),
      trackId: z.string(),
    }),
  );

export const updateTrackSocial = oc
  .route({
    method: "PATCH",
    operationId: "updateTrackSocial",
    path: "/admin/tracks/{trackId}/social/{platform}",
    summary: "Update a finding's per-platform publication status",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      platform: z.string(),
      scheduledFor: z.unknown().optional(),
      status: z.unknown().optional(),
      trackId: z.string(),
      url: z.unknown().optional(),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      platform: z.string(),
      status: z.string(),
      trackId: z.string(),
    }),
  );

export const draftTrackSocial = oc
  .route({
    method: "POST",
    operationId: "draftTrackSocial",
    path: "/admin/tracks/{trackId}/social/{platform}/draft",
    summary: "Push a finding's video to a platform (TikTok draft / YouTube Short)",
    tags: ["Admin"],
  })
  .input(z.object({ platform: z.string(), trackId: z.string() }))
  .output(
    z.object({
      externalId: z.string(),
      ok: z.literal(true),
      platform: z.string(),
      status: z.enum(["draft", "published"]),
      trackId: z.string(),
    }),
  );

export const capturePostUrls = oc
  .route({
    method: "POST",
    operationId: "capturePostUrls",
    path: "/admin/social/posts/capture",
    summary: "Capture missing YouTube/TikTok post URLs from Postiz (the sweep)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ limit: z.unknown().optional() }))
  .output(
    z.object({
      captured: z.array(z.object({ platform: z.string(), trackId: z.string(), url: z.string() })),
      ok: z.literal(true),
      polled: z.number(),
    }),
  );

export const advancePublishQueue = oc
  .route({
    method: "POST",
    operationId: "advancePublishQueue",
    path: "/admin/social/publish/advance",
    summary: "Advance freshly-rendered findings into the publish push (kill-switch aware)",
    tags: ["Admin"],
  })
  .input(z.looseObject({}))
  .output(
    z.object({
      candidates: z.number(),

      failed: z.array(
        z.object({
          platform: z.enum(["tiktok", "youtube"]),
          trackId: z.string(),
        }),
      ),

      held: z.array(
        z.object({
          missing: z.array(z.string()).optional(),
          platform: z.enum(["tiktok", "youtube"]),
          reason: z.enum([
            "bundle_incomplete",
            "daily_cap",
            "no_caption",
            "tiktok_inbox_full",
            "youtube_url_pending",
          ]),
          trackId: z.string(),
        }),
      ),
      ok: z.literal(true),

      paused: z.boolean(),

      pushed: z.array(
        z.object({
          externalId: z.string(),
          logId: z.string(),
          platform: z.enum(["tiktok", "youtube"]),
          status: z.enum(["draft", "published"]),
          trackId: z.string(),
        }),
      ),
    }),
  );

export const setPublishAdvance = oc
  .route({
    method: "PUT",
    operationId: "setPublishAdvance",
    path: "/admin/social/publish/advance/state",
    summary: "Pause / resume the render → publish auto-advance (the kill switch)",
    tags: ["Admin"],
  })
  .input(z.object({ paused: z.boolean() }))
  .output(z.object({ ok: z.literal(true), paused: z.boolean() }));

export const recordSocialMetrics = oc
  .route({
    method: "POST",
    operationId: "recordSocialMetrics",
    path: "/admin/social/metrics/record",
    summary: "Snapshot each published post's Postiz performance into the social-metrics ledger",
    tags: ["Admin"],
  })
  .input(z.looseObject({}))
  .output(
    z.object({
      budget: z.number().int(),

      configured: z.boolean(),

      day: z.string(),

      eligible: z.number().int(),

      failed: z.number().int(),

      inserted: z.number().int(),

      missing: z.number().int(),
      ok: z.literal(true),

      polled: z.number().int(),

      referrals: z.object({
        arrivals: z.array(z.object({ pageviews: z.number().int(), platform: z.string() })),
        configured: z.boolean(),
        total: z.number().int(),
      }),

      tiktok: z.object({
        configured: z.boolean().nullable(),

        failed: z.number().int(),

        fetched: z.number().int().nullable(),

        inserted: z.number().int().nullable(),

        matched: z.number().int().nullable(),

        skipped: z.number().int().nullable(),
      }),

      youtube: z.object({
        configured: z.boolean().nullable(),

        failed: z.number().int(),

        fetched: z.number().int().nullable(),

        inserted: z.number().int().nullable(),

        matched: z.number().int().nullable(),

        skipped: z.number().int().nullable(),
      }),
    }),
  );

const ReachSeriesPointSchema = z
  .object({ day: z.string(), views: z.number().int() })
  .meta({ id: "ReachSeriesPoint" });

const ReachPostRowSchema = z
  .object({
    artists: z.array(z.string()),
    averageViewDurationSeconds: z.number().int().nullable(),
    averageViewPercentage: z.number().nullable(),
    capturedDay: z.string(),
    comments: z.number().int().nullable(),
    dailyViewVelocity: z.number().nullable(),
    externalId: z.string(),
    likes: z.number().int().nullable(),
    logId: z.string().nullable(),
    plateSubject: z.string().nullable(),
    platform: z.enum(["tiktok", "youtube"]),
    publishedAt: z.string().nullable(),
    series: z.array(ReachSeriesPointSchema),
    shares: z.number().int().nullable(),
    snapshotCount: z.number().int(),
    source: z.enum(["csv", "postiz", "tiktok_display", "youtube_analytics"]),
    structure: z.string().nullable(),
    title: z.string().nullable(),
    trackId: z.string(),
    url: z.string().nullable(),
    velocityDaySpan: z.number().nullable(),
    velocityViewsDelta: z.number().int().nullable(),
    views: z.number().int().nullable(),
    watchTimeSeconds: z.number().int().nullable(),
  })
  .meta({ id: "ReachPostRow" });

const ReachPivotCellSchema = z
  .object({
    count: z.number().int(),
    meanRetention: z.number().nullable(),
    meanViews: z.number(),
    medianViews: z.number(),
    platform: z.enum(["tiktok", "youtube"]),
    retentionCount: z.number().int(),
    value: z.string(),
  })
  .meta({ id: "ReachPivotCell" });

const ReachPivotSchema = z
  .object({
    axis: z.enum(["plateSubject", "structure"]),
    cells: z.array(ReachPivotCellSchema),
  })
  .meta({ id: "ReachPivot" });

export const getSocialMetrics = oc
  .route({
    method: "GET",
    operationId: "getSocialMetrics",
    path: "/admin/social/metrics",
    summary: "The reach board — per-post velocity + platform × creative-axis pivots",
    tags: ["Admin"],
  })
  .input(z.object({ windowDays: z.string().optional() }))
  .output(
    z.object({
      pivots: z.object({ plateSubject: ReachPivotSchema, structure: ReachPivotSchema }),
      posts: z.array(ReachPostRowSchema),
      totalPosts: z.number().int(),
      windowDays: z.number().int(),
    }),
  );

export const adminSocialContract = {
  advance_publish_queue: advancePublishQueue,
  capture_post_urls: capturePostUrls,
  draft_track_social: draftTrackSocial,
  get_social_metrics: getSocialMetrics,
  list_track_social: listTrackSocial,
  record_social_metrics: recordSocialMetrics,
  set_publish_advance: setPublishAdvance,
  update_track_social: updateTrackSocial,
};
