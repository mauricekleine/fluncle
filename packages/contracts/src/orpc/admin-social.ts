// The `admin-social` domain contract module — a finding's per-platform
// publication control plane (list state, update status, push a draft). Part of
// the admin fan-out, built on the same pattern as `./admin-tracks.ts`.
//
//   - `list_track_social` — admin tier (live `requireAdmin`): a read.
//   - `update_track_social` — operator tier (live `requireOperator`): the manual
//     review feedback (status + url), so the agent gets a 403.
//   - `draft_track_social` — admin tier WITH a FIELD-LEVEL operator guard, ported
//     VERBATIM from the live route: `requireAdmin` gates entry, then `youtube`
//     (a direct PUBLIC upload) additionally requires `requireOperator`, while
//     `tiktok` (a SELF_ONLY inbox draft) is agent-allowed. The handler reads
//     `context.role` to reproduce that exact branch (a youtube push by the agent
//     is a 403, a tiktok push is allowed).
//   - `capture_post_urls` — admin tier: the polling SWEEP that captures the public
//     YouTube/TikTok post URLs Postiz withholds on create (built from the native
//     content id on `/missing`) and links each release-id for analytics.
//
// Inputs stay LOOSE/passthrough by design — the live routes narrow `unknown`
// in-handler and emit their own codes (`bad_status`/`url_required`/
// `unsupported_platform`/`no_video`/`no_post`), so a permissive contract keeps
// those codes byte-for-byte for the `fluncle admin` CLI + the enrichment agent.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { SocialPostItemSchema } from "./_shared";

/**
 * `list_track_social` → `GET /admin/tracks/{trackId}/social` (operationId
 * `listTrackSocial`).
 *
 * Admin tier (live `requireAdmin`). The track's per-platform publication rows.
 * Preserves the live `{ ok: true, posts, trackId }` envelope and the
 * `not_found`/404 (`trackNotFoundResponse`).
 */
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

/**
 * `update_track_social` → `PATCH /admin/tracks/{trackId}/social/{platform}`
 * (operationId `updateTrackSocial`).
 *
 * Operator tier (live `requireOperator`). Update the per-platform status (+ the
 * public URL) after the operator reviews the draft in-app. LOOSE body — the live
 * route validates `status`/`url` itself (`bad_status`/`url_required`), so the
 * contract stays permissive. Preserves the `{ ok: true, platform, status,
 * trackId }` envelope and the `bad_status`/`url_required`/`no_post`/`not_found`
 * codes.
 */
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

/**
 * `draft_track_social` → `POST /admin/tracks/{trackId}/social/{platform}/draft`
 * (operationId `draftTrackSocial`).
 *
 * Admin tier (live `requireAdmin`) WITH a field-level operator guard for
 * `youtube` (a direct PUBLIC upload — operator only) read in-handler from
 * `context.role`; `tiktok` (a SELF_ONLY inbox draft) is agent-allowed. Pushes the
 * track's video + caption via Postiz. Preserves the `{ ok: true, externalId,
 * platform, status, trackId }` envelope and the `unsupported_platform`/
 * `no_video`/`no_log_id`/`not_found` codes.
 */
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

/**
 * `capture_post_urls` → `POST /admin/social/posts/capture` (operationId
 * `capturePostUrls`).
 *
 * Admin tier (the on-box capture cron is agent-allowed — it only fills the public
 * `url` Postiz withheld on create and links the analytics release-id; it publishes
 * nothing). The polling SWEEP: select every youtube/tiktok post with a Postiz id
 * but no captured `url` (status published/draft), poll Postiz's `/missing`, build
 * each permalink from the platform's native content id, record it, link the
 * release-id, and flip a captured TikTok `draft` → `published`. LOOSE body — the
 * handler clamps `limit` itself. Returns the `{ ok, polled, captured }` envelope.
 */
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

/**
 * `advance_publish_queue` → `POST /admin/social/publish/advance` (operationId
 * `advancePublishQueue`).
 *
 * ADMIN tier (`adminAuth`, NOT `operatorGuard`): the on-box `fluncle-publish-advance` cron
 * drives it with its AGENT token — the `drip_clips` / `capture_post_urls` precedent (the
 * box holds no Postiz key, so it only TRIGGERS the Worker, which owns the key). One
 * bounded, idempotent tick of the render → publish auto-advance: the kill switch first (a
 * paused tick pushes nothing), then at most `ADVANCE_PER_TICK_CAP` READY findings are
 * pushed — YouTube as the hands-off public Short, TikTok as the inbox draft the operator
 * finishes in-app.
 *
 * Note the tier inversion this deliberately carries: `draft_track_social` refuses a
 * YouTube push from the agent role (a direct public upload was operator-only). The
 * auto-advance IS the decision to let the machine make that push — so the gate moves off
 * the request tier and onto the kill switch + the readiness gates, exactly as the clip
 * drip-feed moved Instagram posting behind `clip_drip_paused`. Nothing else may push
 * YouTube as the agent: the tier stays on `draft_track_social`.
 *
 * Empty body (`{}`).
 */
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
      /** Findings inspected this tick (after the per-tick cap). */
      candidates: z.number(),
      /** Pushes that errored — the row is left `failed` for the operator, never retried. */
      failed: z.array(
        z.object({
          platform: z.enum(["tiktok", "youtube"]),
          trackId: z.string(),
        }),
      ),
      /** Platforms held back, and why — a stuck advance says so out loud. */
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
      /** The kill switch was on — nothing was pushed. */
      paused: z.boolean(),
      /** The pushes that actually went out. */
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

/**
 * `set_publish_advance` → `PUT /admin/social/publish/advance/state` (operationId
 * `setPublishAdvance`).
 *
 * OPERATOR tier — the auto-advance's KILL SWITCH (the `set_clip_drip` shape, on the same
 * `settings` KV). Pausing halts every future auto-publish within one tick, changing
 * nothing else about a finding; resuming continues it. The agent may never touch it.
 */
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

/** The `admin-social` domain's ops, merged into the root contract by `./index.ts`. */
export const adminSocialContract = {
  advance_publish_queue: advancePublishQueue,
  capture_post_urls: capturePostUrls,
  draft_track_social: draftTrackSocial,
  list_track_social: listTrackSocial,
  set_publish_advance: setPublishAdvance,
  update_track_social: updateTrackSocial,
};
