// The `admin-social` domain contract module — a finding's per-platform
// publication control plane (list state, update status, push a draft). Part of
// the admin fan-out (docs/orpc-migration-brief.md), built on the same pattern as
// `./admin-tracks.ts`.
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

/** The `admin-social` domain's ops, merged into the root contract by `./index.ts`. */
export const adminSocialContract = {
  capture_post_urls: capturePostUrls,
  draft_track_social: draftTrackSocial,
  list_track_social: listTrackSocial,
  update_track_social: updateTrackSocial,
};
