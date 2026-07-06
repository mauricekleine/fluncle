// The `admin-mixtapes` domain contract module — the audio→Mixcloud /
// video→YouTube distribution control plane for PROMOTED mixtapes. Part of the
// admin fan-out, built on the same pattern as `./admin-tracks.ts`.
//
// A mixtape is only ever BORN via `promote_recording` (RFC plan→recording→mixtape):
// the draft-authoring ops (`create_mixtape`, the members writes, `publish_mixtape`,
// `delete_mixtape`) retired with draft mixtapes — plans (`recordings` kind=plan)
// own pre-publish authoring now.
//
// VERIFIED auth tiers against the live handlers:
//   - `list_mixtapes_admin` (GET) and `get_mixtape_social` (GET) — admin tier
//     (live `requireAdmin`): reads, agent-allowed.
//   - everything else — operator tier (live `requireOperator`): the post-publish
//     update and every distribution step. The agent gets a 403.
//
// Mutating bodies stay LOOSE/passthrough by design — the live routes pass the raw
// JSON straight to the server helpers (`updateMixtape`/`setMixtapeCues`), which
// validate + throw their own codes — so the contract must not pre-reject. The
// distribution steps validate their own narrow fields in-handler
// (`invalid_request`/`mixtape_not_distributing`/`mixtape_no_log_id`/the YouTube
// 502s), kept byte-for-byte.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { ClipDTOSchema, MixtapeDTOSchema, MixtapeSocialPostItemSchema } from "./_shared";

/** The `{ mixtape, ok }` envelope most mixtape ops return. */
const MixtapeEnvelope = z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true) });

/** The `{ clip, ok }` envelope the single-clip writes return. */
const ClipEnvelope = z.object({ clip: ClipDTOSchema, ok: z.literal(true) });

/**
 * `list_mixtapes_admin` → `GET /admin/mixtapes` (operationId `listMixtapesAdmin`).
 *
 * Admin tier (live `requireAdmin`). The full mixtape list, hydrated + including
 * the minted-but-uploading `distributing` state (distinct from the public
 * `list_mixtapes`, which is published-only). Preserves `{ mixtapes, ok }`.
 */
export const listMixtapesAdmin = oc
  .route({
    method: "GET",
    operationId: "listMixtapesAdmin",
    path: "/admin/mixtapes",
    summary: "List every mixtape (hydrated, including distributing)",
    tags: ["Admin"],
  })
  .output(z.object({ mixtapes: z.array(MixtapeDTOSchema), ok: z.literal(true) }));

/**
 * `update_mixtape` → `PATCH /admin/mixtapes/{mixtapeId}` (operationId
 * `updateMixtape`).
 *
 * Operator tier (live `requireOperator`). LOOSE body — `updateMixtape` validates.
 * Preserves `{ mixtape, ok }`.
 */
export const updateMixtape = oc
  .route({
    method: "PATCH",
    operationId: "updateMixtape",
    path: "/admin/mixtapes/{mixtapeId}",
    summary: "Update a mixtape's fields",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string() }))
  .output(MixtapeEnvelope);

/**
 * `get_mixtape_social` → `GET /admin/mixtapes/{mixtapeId}/social` (operationId
 * `getMixtapeSocial`).
 *
 * Admin tier (live `requireAdmin`). The mixtape's per-platform distribution rows.
 * Preserves `{ mixtapeId, ok, posts }`.
 */
export const getMixtapeSocial = oc
  .route({
    method: "GET",
    operationId: "getMixtapeSocial",
    path: "/admin/mixtapes/{mixtapeId}/social",
    summary: "List a mixtape's per-platform distribution rows",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(
    z.object({
      mixtapeId: z.string(),
      ok: z.literal(true),
      posts: z.array(MixtapeSocialPostItemSchema),
    }),
  );

/**
 * `finalize_mixtape_mixcloud` → `POST /admin/mixtapes/{mixtapeId}/mixcloud/finalize`
 * (operationId `finalizeMixtapeMixcloud`).
 *
 * Operator tier (live `requireOperator`). The CLI uploaded the audio to Mixcloud
 * and POSTs the resolved url here; the Worker records the post + flips the
 * mixtape published on first link. LOOSE body — the live route validates `url`
 * (`invalid_request`/400). Preserves `{ mixtape, ok, platform }`.
 */
export const finalizeMixtapeMixcloud = oc
  .route({
    method: "POST",
    operationId: "finalizeMixtapeMixcloud",
    path: "/admin/mixtapes/{mixtapeId}/mixcloud/finalize",
    summary: "Record a mixtape's published Mixcloud cloudcast",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      externalId: z.unknown().optional(),
      mixtapeId: z.string(),
      url: z.unknown().optional(),
    }),
  )
  .output(z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true), platform: z.string() }));

/**
 * `initiate_mixtape_youtube` → `POST /admin/mixtapes/{mixtapeId}/youtube/initiate`
 * (operationId `initiateMixtapeYoutube`).
 *
 * Operator tier (live `requireOperator`). Step 1 of the YouTube resumable upload:
 * open the session, return the session URI + a short-lived token. LOOSE body — the
 * live route validates `contentLength` (`invalid_request`/400) and gates on the
 * mixtape status (`mixtape_not_distributing`/409, `mixtape_no_log_id`/409) +
 * YouTube errors (the 502s). Preserves `{ accessToken, ok, sessionUri }`.
 */
export const initiateMixtapeYoutube = oc
  .route({
    method: "POST",
    operationId: "initiateMixtapeYoutube",
    path: "/admin/mixtapes/{mixtapeId}/youtube/initiate",
    summary: "Open a mixtape's YouTube resumable upload session",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      contentLength: z.unknown().optional(),
      contentType: z.unknown().optional(),
      mixtapeId: z.string(),
    }),
  )
  .output(z.object({ accessToken: z.string(), ok: z.literal(true), sessionUri: z.string() }));

/**
 * `finalize_mixtape_youtube` → `POST /admin/mixtapes/{mixtapeId}/youtube/finalize`
 * (operationId `finalizeMixtapeYoutube`).
 *
 * Operator tier (live `requireOperator`). Step 3: the CLI finished the PUT and
 * reports the videoId; record it published (best-effort thumbnail). LOOSE body —
 * the live route validates `videoId` (`invalid_request`/400). Preserves
 * `{ mixtape, ok, platform }`.
 */
export const finalizeMixtapeYoutube = oc
  .route({
    method: "POST",
    operationId: "finalizeMixtapeYoutube",
    path: "/admin/mixtapes/{mixtapeId}/youtube/finalize",
    summary: "Record a mixtape's uploaded YouTube video",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string(), videoId: z.unknown().optional() }))
  .output(z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true), platform: z.string() }));

/**
 * `publish_mixtape_youtube` → `POST /admin/mixtapes/{mixtapeId}/youtube/publish`
 * (operationId `publishMixtapeYoutube`).
 *
 * Operator tier (live `requireOperator`). The recurring human gate: flip the
 * unlisted mixtape video to public. Gates on the youtube distribution row
 * (`youtube_not_distributed`/409) + YouTube errors (502). Preserves `{ ok, url }`.
 */
export const publishMixtapeYoutube = oc
  .route({
    method: "POST",
    operationId: "publishMixtapeYoutube",
    path: "/admin/mixtapes/{mixtapeId}/youtube/publish",
    summary: "Flip a mixtape's unlisted YouTube video to public",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(z.object({ ok: z.literal(true), url: z.string() }));

/**
 * `resync_mixtape_youtube` → `POST /admin/mixtapes/{mixtapeId}/youtube/resync`
 * (operationId `resyncMixtapeYoutube`).
 *
 * Operator tier (live `requireOperator`). Re-derive the YouTube description
 * (prose + `fluncle://<logId>` + the chapter block) from the mixtape's CURRENT
 * cues and push it to the already-uploaded video via `videos.update` — no
 * re-upload. Server-side (the Worker holds the refresh token), like
 * `publish_mixtape_youtube`. It EDITS live published content, so the agent token
 * 403s. Gates on the youtube distribution row (`youtube_not_distributed`/409) +
 * the committed Log ID (`mixtape_no_log_id`/409) + YouTube errors (502).
 * Preserves a `{ ok, url, videoId }` envelope.
 */
export const resyncMixtapeYoutube = oc
  .route({
    method: "POST",
    operationId: "resyncMixtapeYoutube",
    path: "/admin/mixtapes/{mixtapeId}/youtube/resync",
    summary: "Re-sync a mixtape's live YouTube description + chapters from its current cues",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(z.object({ ok: z.literal(true), url: z.string(), videoId: z.string() }));

/**
 * `resync_mixtape_mixcloud` → `POST /admin/mixtapes/{mixtapeId}/mixcloud/resync`
 * (operationId `resyncMixtapeMixcloud`).
 *
 * Operator tier (live `requireOperator`). Re-derive the Mixcloud `sections[]`
 * tracklist from the mixtape's CURRENT cues and push it to the already-uploaded
 * cloudcast via the Mixcloud edit endpoint — sections-only, NO audio re-upload
 * (posting any `sections-*` field overwrites the whole tracklist; name/description/
 * picture are untouched). Server-side parity with `resync_mixtape_youtube`: the
 * Worker holds the `mixcloud_auth` token, so this bytes-free edit belongs server-side
 * (unlike the multi-GB upload). It EDITS live published content, so the agent token
 * 403s. Gates on the mixcloud distribution row (`mixcloud_not_distributed`/409), at
 * least one cued member (`mixcloud_no_cues`/409), and Mixcloud errors (502). Preserves
 * a `{ ok, url }` envelope.
 */
export const resyncMixtapeMixcloud = oc
  .route({
    method: "POST",
    operationId: "resyncMixtapeMixcloud",
    path: "/admin/mixtapes/{mixtapeId}/mixcloud/resync",
    summary: "Re-sync a mixtape's live Mixcloud tracklist sections from its current cues",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(z.object({ ok: z.literal(true), url: z.string() }));

// ── Fluncle Studio: clips + cue backfill ──────────────────────────────────────
// A clip is a lightweight 9:16 derivative of a mixtape's set video — many per set.
// LOOSE/passthrough bodies, like the rest of the domain: the server helpers
// (`createClip`/`updateClip`/`setMixtapeCues`) validate + throw their own codes, so
// the contract must not pre-reject. The remaining presign op (`presign_clip_upload`)
// is DEFERRED to Unit C (it signs the box's clip output); `presign_set_video_upload`
// below ships with Unit A (it signs the CLI's set-video rendition upload).

/**
 * `list_clips` → `GET /admin/clips` (operationId `listClips`).
 *
 * Admin tier (`requireAdmin`, agent-allowed). Every clip, optionally filtered by
 * `recordingId` and/or `status` — the SAME read the per-set editor (one recording)
 * and the cross-set clip library (all recordings) both consume. Preserves
 * `{ clips, ok }`.
 */
export const listClips = oc
  .route({
    method: "GET",
    operationId: "listClips",
    path: "/admin/clips",
    summary: "List clips (optionally filtered by recording and/or status)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      recordingId: z.string().optional(),
      status: z.string().optional(),
    }),
  )
  .output(z.object({ clips: z.array(ClipDTOSchema), ok: z.literal(true) }));

/**
 * `create_clip` → `POST /admin/recordings/{recordingId}/clips` (operationId
 * `createClip`).
 *
 * Operator tier (`requireOperator`). Mint one clip row for a RECORDING (the RFC
 * recording-primitive, Design B: all new clips are recording-scoped; the legacy
 * mixtape-scoped create path is retired). LOOSE body — `createClip` validates the cut
 * window + framing. Preserves `{ clip, ok }`.
 */
export const createClip = oc
  .route({
    method: "POST",
    operationId: "createClip",
    path: "/admin/recordings/{recordingId}/clips",
    summary: "Create a clip for a recording (queues a cut)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ recordingId: z.string() }))
  .output(ClipEnvelope);

/**
 * `update_clip` → `PATCH /admin/clips/{clipId}` (operationId `updateClip`).
 *
 * Operator tier (`requireOperator`). Edit a clip's window/framing/caption/status.
 * LOOSE body — `updateClip` validates. Preserves `{ clip, ok }`.
 */
export const updateClip = oc
  .route({
    method: "PATCH",
    operationId: "updateClip",
    path: "/admin/clips/{clipId}",
    summary: "Update a clip's fields",
    tags: ["Admin"],
  })
  .input(z.looseObject({ clipId: z.string() }))
  .output(ClipEnvelope);

/**
 * `delete_clip` → `DELETE /admin/clips/{clipId}` (operationId `deleteClip`).
 *
 * Operator tier (`requireOperator`). Prune a bad cut from the library. Preserves
 * the `{ ok }` envelope.
 */
export const deleteClip = oc
  .route({
    method: "DELETE",
    operationId: "deleteClip",
    path: "/admin/clips/{clipId}",
    summary: "Delete a clip",
    tags: ["Admin"],
  })
  .input(z.object({ clipId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

/**
 * `set_mixtape_cues` → `PUT /admin/mixtapes/{mixtapeId}/cues` (operationId
 * `setMixtapeCues`).
 *
 * Operator tier (`requireOperator`). The HARDENED post-publish cue backfill: re-time
 * the `start_ms` of a MINTED mixtape's EXISTING members without touching the frozen
 * set/order (each cue `ref` is a current trackId). LOOSE body — `setMixtapeCues`
 * validates the cue shape, asserts the mixtape is non-draft + the member set is
 * unchanged, and enforces monotonic, start-at-0 cues (YouTube chapter rules).
 * Preserves `{ mixtape, ok }`.
 */
export const setMixtapeCues = oc
  .route({
    method: "PUT",
    operationId: "setMixtapeCues",
    path: "/admin/mixtapes/{mixtapeId}/cues",
    summary: "Backfill a published mixtape's per-track cues (start_ms)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string() }))
  .output(MixtapeEnvelope);

/**
 * `update_mixtape_cue` → `PUT /admin/mixtapes/{mixtapeId}/cues/{ref}` (operationId
 * `updateMixtapeCue`).
 *
 * Operator tier (`requireOperator`). The INTERACTIVE single-cue write behind the
 * Fluncle Studio cue rail — upsert ONE minted member's `start_ms` (by track `ref`), or
 * clear it (`startMs: null`). Deliberately NOT `set_mixtape_cues` (plural): that op is
 * the ALL-OR-NOTHING cue-sheet backfill (one cue per member, start-at-0, strictly
 * monotonic — the CLI full-backfill path); this singular op has NO coverage/order
 * constraint, so the operator marks tracks one at a time, out of order, mid-session. It
 * nests under the same `/cues` collection, distinguished by the `{ref}` member segment
 * — REST-symmetric with the batch PUT, a distinct op. Published-safe (a minted
 * `distributing`/`published` set). LOOSE body — `setMixtapeCue` validates `startMs` +
 * asserts non-draft + membership. Preserves `{ mixtape, ok }`.
 */
export const updateMixtapeCue = oc
  .route({
    method: "PUT",
    operationId: "updateMixtapeCue",
    path: "/admin/mixtapes/{mixtapeId}/cues/{ref}",
    summary: "Set or clear one member's cue (start_ms) on a minted mixtape",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string(), ref: z.string(), startMs: z.unknown().optional() }))
  .output(MixtapeEnvelope);

/**
 * `presign_set_video_upload` → `POST /admin/mixtapes/{mixtapeId}/set-video/presign`
 * (operationId `presignSetVideoUpload`).
 *
 * Operator tier (`requireOperator`). Fluncle Studio Unit A: open a multipart
 * direct-to-R2 upload for a mixtape's 1080p set-video rendition at `<logId>/set.mp4`
 * and presign every leg of it (one PUT URL per `partCount` parts + the complete +
 * abort URLs). The rendition is ~1.5GB — past the single-PUT presign budget — so the
 * CLI streams the parts straight to R2 and completes the upload itself (the Worker
 * can't proxy the bytes). LOOSE body — the handler validates `partCount` and gates on
 * the mixtape being minted (`invalid_request`/400, `mixtape_not_distributing`/409,
 * `mixtape_no_log_id`/409). Returns `{ ok, mixtapeId, logId, key, uploadId, parts,
 * completeUrl, abortUrl }`.
 */
export const presignSetVideoUpload = oc
  .route({
    method: "POST",
    operationId: "presignSetVideoUpload",
    path: "/admin/mixtapes/{mixtapeId}/set-video/presign",
    summary: "Open + presign a multipart direct-to-R2 upload for a mixtape's set video",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      contentType: z.unknown().optional(),
      mixtapeId: z.string(),
      partCount: z.unknown().optional(),
    }),
  )
  .output(
    z.object({
      abortUrl: z.string(),
      completeUrl: z.string(),
      key: z.string(),
      logId: z.string(),
      mixtapeId: z.string(),
      ok: z.literal(true),
      parts: z.array(z.object({ partNumber: z.number(), url: z.string() })),
      uploadId: z.string(),
    }),
  );

/**
 * `presign_clip_upload` → `POST /admin/clips/{clipId}/cut/presign` (operationId
 * `presignClipUpload`).
 *
 * AGENT tier (`requireAdmin`, agent-allowed — adminAuth only, NO operatorGuard):
 * Fluncle Studio Unit C, the box's clip-cut path. The on-box `fluncle-studio-clip`
 * cron's agent token signs its OWN clip output, the same way the render box signs its
 * track-video uploads (`presign_track_video_uploads`). A clip is < 100 MB, so this is
 * a SINGLE-PUT presign (the `r2-presign.ts` single-PUT path — NO multipart) for the
 * clip's pseudo-finding master `<clipId>/footage.mp4`. LOOSE body — the handler
 * defaults `contentType` and confirms the clip exists (`clip_not_found`/404). Returns
 * `{ ok, clipId, key, url, contentType }` (one signed PUT URL; the CLI MUST replay the
 * identical `contentType` header — it is baked into the signature).
 */
export const presignClipUpload = oc
  .route({
    method: "POST",
    operationId: "presignClipUpload",
    // Path-symmetric with `finalize_clip_cut` (both nest under the `/cut/` artifact),
    // mirroring the `set-video/presign` + `video/finalize` precedent pairs.
    path: "/admin/clips/{clipId}/cut/presign",
    summary: "Presign a single-PUT direct-to-R2 upload for a clip's cut output",
    tags: ["Admin"],
  })
  .input(z.looseObject({ clipId: z.string(), contentType: z.unknown().optional() }))
  .output(
    z.object({
      clipId: z.string(),
      contentType: z.string(),
      key: z.string(),
      ok: z.literal(true),
      url: z.string(),
    }),
  );

/**
 * `finalize_clip_cut` → `POST /admin/clips/{clipId}/cut/finalize` (operationId
 * `finalizeClipCut`).
 *
 * AGENT tier (`requireAdmin`, agent-allowed — adminAuth only, NO operatorGuard):
 * Fluncle Studio Unit C. After the box uploads `<clipId>/footage.mp4`, it calls this
 * to mark the cut `done` (the `update_clip` operator op is unreachable to the agent
 * token, so the box gets its own narrow agent-tier finalize — the `finalize_track_video`
 * precedent for the render box). The handler also PURGES the clip's stale edge
 * renditions server-side (the box holds no Cloudflare creds), so a RE-CUT to the same
 * `clipId` doesn't keep serving the old cut (#152 lesson). Returns `{ clip, ok }`.
 */
export const finalizeClipCut = oc
  .route({
    method: "POST",
    operationId: "finalizeClipCut",
    path: "/admin/clips/{clipId}/cut/finalize",
    summary: "Mark a clip's cut done + purge its stale edge renditions",
    tags: ["Admin"],
  })
  .input(z.object({ clipId: z.string() }))
  .output(ClipEnvelope);

/**
 * `get_clip_caption` → `GET /admin/clips/{clipId}/caption` (operationId
 * `getClipCaption`).
 *
 * Admin tier (agent-allowed read). The BUILT caption for a clip (RFC
 * plan→recording→mixtape §5) — the stored-clean caption with the `fluncle://`
 * coordinate line(s) appended: one line for the promoted mixtape's `.F.` Log ID if the
 * clip's source recording is published, else one line per finding the clip window
 * overlaps (a blend = multiple lines). The clip-card UI (Wave 3-B) shows + copies
 * `builtCaption`; `caption`/`coordinates` are returned split for a card that renders
 * the coordinate chips separately. Preserves an `{ ok, clipId, … }` envelope.
 */
export const getClipCaption = oc
  .route({
    method: "GET",
    operationId: "getClipCaption",
    path: "/admin/clips/{clipId}/caption",
    summary: "Build a clip's caption (clean copy + the fluncle:// coordinate line(s))",
    tags: ["Admin"],
  })
  .input(z.object({ clipId: z.string() }))
  .output(
    z.object({
      builtCaption: z.string(),
      caption: z.string().optional(),
      clipId: z.string(),
      coordinates: z.array(z.string()),
      ok: z.literal(true),
    }),
  );

/** One clip's Instagram drip-feed state (the `mixtape_clip_social_posts` row). */
const ClipSocialPostSchema = z.object({
  caption: z.string().optional(),
  clipId: z.string(),
  createdAt: z.string(),
  platform: z.string(),
  postedUrl: z.string().optional(),
  postizId: z.string().optional(),
  scheduledFor: z.string(),
  status: z.enum(["failed", "posted", "scheduled"]),
  updatedAt: z.string(),
});

/**
 * `drip_clips` → `POST /admin/clips/drip` (operationId `dripClips`).
 *
 * ADMIN tier (`adminAuth`, NOT `operatorGuard`): the box's on-box `fluncle-clip-drip`
 * cron drives this with its AGENT token — the `finalize_clip_cut` / `record_health`
 * precedent (the box holds no Postiz key, so it just TRIGGERS the Worker, which owns the
 * key). One bounded tick of the drip-feed: it first runs a CAPTURE pass (back-filling the
 * live IG permalink onto prior-tick posts — Instagram publishes the Reel async, so the
 * permalink lands a tick later; reported as `captured`), then, if the kill switch is on it
 * no-ops (`paused`), else it posts the due, cut clips to Instagram via Postiz, bounded by a
 * per-tick cap AND the rolling-24h IG cap. Idempotent (a `posted` row never re-fires). Empty
 * body (`{}`).
 */
export const dripClips = oc
  .route({
    method: "POST",
    operationId: "dripClips",
    path: "/admin/clips/drip",
    summary: "Post one bounded tick of due, cut clips to Instagram (kill-switch aware)",
    tags: ["Admin"],
  })
  .input(z.looseObject({}))
  .output(
    z.object({
      attempted: z.number(),
      // Live IG permalinks back-filled onto prior-tick posts this pass (the capture-back:
      // Instagram publishes the Reel async, so its permalink lands a tick after the push).
      captured: z.number(),
      failed: z.number(),
      ok: z.literal(true),
      // The kill switch was on this tick — nothing was posted (the capture pass still ran).
      paused: z.boolean(),
      posted: z.number(),
      // Due rows the per-tick / 24h cap deferred to a later tick.
      skippedCapped: z.number(),
    }),
  );

/**
 * `list_clip_posts` → `GET /admin/clips/social` (operationId `listClipPosts`).
 *
 * Admin tier (agent-allowed read). Every clip's Instagram drip-feed row, so the clip
 * library / CLI can show each clip's `scheduled/posted/failed` state alongside the clip.
 */
export const listClipPosts = oc
  .route({
    method: "GET",
    operationId: "listClipPosts",
    path: "/admin/clips/social",
    summary: "List every clip's Instagram drip-feed schedule + status",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), posts: z.array(ClipSocialPostSchema) }));

/**
 * `set_clip_schedule` → `PATCH /admin/clips/{clipId}/schedule` (operationId
 * `setClipSchedule`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`): the operator's schedule control — set or
 * override a clip's drip slot (a fresh caption snapshot is rebuilt server-side). Not the
 * box's — the box only ticks the drip. `scheduledFor` is an ISO timestamp.
 */
export const setClipSchedule = oc
  .route({
    method: "PATCH",
    operationId: "setClipSchedule",
    path: "/admin/clips/{clipId}/schedule",
    summary: "Set or override a clip's Instagram drip slot",
    tags: ["Admin"],
  })
  .input(z.object({ clipId: z.string(), scheduledFor: z.string() }))
  .output(z.object({ ok: z.literal(true), post: ClipSocialPostSchema }));

/**
 * `set_clip_schedules` → `POST /admin/clips/schedule` (operationId `setClipSchedules`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`): the batch sibling of `set_clip_schedule`.
 * Schedules a whole selection of clips onto the jittered drip queue in one move — each clip
 * rolls a fresh slot off the LIVE queue tail (so consecutive slots chain ~24h apart with
 * real jitter) and snapshots a fresh caption, server-side and sequential. The web clip
 * library's batch bar drives it; not the box's. Returns how many rows were scheduled.
 */
export const setClipSchedules = oc
  .route({
    method: "POST",
    operationId: "setClipSchedules",
    path: "/admin/clips/schedule",
    summary: "Batch-schedule clips onto the Instagram drip queue (jittered ~daily chain)",
    tags: ["Admin"],
  })
  .input(z.object({ clipIds: z.array(z.string()) }))
  .output(z.object({ ok: z.literal(true), scheduled: z.number() }));

/**
 * `delete_clip_schedule` → `DELETE /admin/clips/{clipId}/schedule` (operationId
 * `deleteClipSchedule`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`): the operator's "unschedule" — take a clip
 * off the drip queue (delete its un-posted schedule row). Idempotent (no row ⇒ still `ok`);
 * an already-`posted` row is left intact (unscheduling is for the queue, not for un-recording
 * a live post). REST-symmetric with `set_clip_schedule` (same path, DELETE vs PATCH).
 */
export const deleteClipSchedule = oc
  .route({
    method: "DELETE",
    operationId: "deleteClipSchedule",
    path: "/admin/clips/{clipId}/schedule",
    summary: "Unschedule a clip (take it off the Instagram drip queue)",
    tags: ["Admin"],
  })
  .input(z.object({ clipId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

/**
 * `set_clip_drip` → `PUT /admin/clips/drip/state` (operationId `setClipDrip`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`): the global kill switch. `paused: true`
 * halts every future scheduled post within one tick (the schedule stays intact);
 * `paused: false` resumes the drip. The operator's control, not the box's.
 */
export const setClipDrip = oc
  .route({
    method: "PUT",
    operationId: "setClipDrip",
    path: "/admin/clips/drip/state",
    summary: "Pause or resume the clip drip-feed (the kill switch)",
    tags: ["Admin"],
  })
  .input(z.object({ paused: z.boolean() }))
  .output(z.object({ ok: z.literal(true), paused: z.boolean() }));

/** The `admin-mixtapes` domain's ops, merged into the root contract by `./index.ts`. */
export const adminMixtapesContract = {
  create_clip: createClip,
  delete_clip: deleteClip,
  delete_clip_schedule: deleteClipSchedule,
  drip_clips: dripClips,
  finalize_clip_cut: finalizeClipCut,
  finalize_mixtape_mixcloud: finalizeMixtapeMixcloud,
  finalize_mixtape_youtube: finalizeMixtapeYoutube,
  get_clip_caption: getClipCaption,
  get_mixtape_social: getMixtapeSocial,
  initiate_mixtape_youtube: initiateMixtapeYoutube,
  list_clip_posts: listClipPosts,
  list_clips: listClips,
  list_mixtapes_admin: listMixtapesAdmin,
  presign_clip_upload: presignClipUpload,
  presign_set_video_upload: presignSetVideoUpload,
  publish_mixtape_youtube: publishMixtapeYoutube,
  resync_mixtape_mixcloud: resyncMixtapeMixcloud,
  resync_mixtape_youtube: resyncMixtapeYoutube,
  set_clip_drip: setClipDrip,
  set_clip_schedule: setClipSchedule,
  set_clip_schedules: setClipSchedules,
  set_mixtape_cues: setMixtapeCues,
  update_clip: updateClip,
  update_mixtape: updateMixtape,
  update_mixtape_cue: updateMixtapeCue,
};
