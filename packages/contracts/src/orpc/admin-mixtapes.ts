// The `admin-mixtapes` domain contract module — the mixtape authoring + the
// audio→Mixcloud / video→YouTube distribution control plane. Part of the admin
// fan-out, built on the same pattern as `./admin-tracks.ts`.
//
// VERIFIED auth tiers against the live handlers:
//   - `list_mixtapes_admin` (GET) and `get_mixtape_social` (GET) — admin tier
//     (live `requireAdmin`): reads, agent-allowed.
//   - everything else — operator tier (live `requireOperator`): create/update/
//     delete, the members writes (POST append + PUT replace), publish, and every
//     distribution step. The agent gets a 403.
//
// Mutating bodies stay LOOSE/passthrough by design — the live routes pass the raw
// JSON straight to the server helpers (`createMixtape`/`updateMixtape`/
// `addTracksToMixtape`/`setMixtapeMembers`), which validate + throw their own
// codes — so the contract must not pre-reject. The distribution steps validate
// their own narrow fields in-handler (`invalid_request`/`mixtape_not_distributing`
// /`mixtape_no_log_id`/the YouTube 502s), kept byte-for-byte.

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
 * drafts (distinct from the public `list_mixtapes`). Preserves `{ mixtapes, ok }`.
 */
export const listMixtapesAdmin = oc
  .route({
    method: "GET",
    operationId: "listMixtapesAdmin",
    path: "/admin/mixtapes",
    summary: "List every mixtape (hydrated, including drafts)",
    tags: ["Admin"],
  })
  .output(z.object({ mixtapes: z.array(MixtapeDTOSchema), ok: z.literal(true) }));

/**
 * `create_mixtape` → `POST /admin/mixtapes` (operationId `createMixtape`).
 *
 * Operator tier (live `requireOperator`). LOOSE body — `createMixtape` validates.
 * Preserves `{ mixtape, ok }`.
 */
export const createMixtape = oc
  .route({
    method: "POST",
    operationId: "createMixtape",
    path: "/admin/mixtapes",
    summary: "Create a mixtape (draft)",
    tags: ["Admin"],
  })
  .input(z.looseObject({}))
  .output(MixtapeEnvelope);

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
 * `delete_mixtape` → `DELETE /admin/mixtapes/{mixtapeId}` (operationId
 * `deleteMixtape`).
 *
 * Operator tier (live `requireOperator`). Preserves the live `{ ok }` envelope.
 */
export const deleteMixtape = oc
  .route({
    method: "DELETE",
    operationId: "deleteMixtape",
    path: "/admin/mixtapes/{mixtapeId}",
    summary: "Delete a mixtape",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

/**
 * `add_mixtape_members` → `POST /admin/mixtapes/{mixtapeId}/members` (operationId
 * `addMixtapeMembers`).
 *
 * Operator tier (live `requireOperator`). APPEND to the tracklist (the board's
 * "Add to mixtape"). LOOSE body — `addTracksToMixtape` validates. Preserves
 * `{ mixtape, ok }`.
 */
export const addMixtapeMembers = oc
  .route({
    method: "POST",
    operationId: "addMixtapeMembers",
    path: "/admin/mixtapes/{mixtapeId}/members",
    summary: "Append tracks to a mixtape's tracklist (draft-only)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string() }))
  .output(MixtapeEnvelope);

/**
 * `set_mixtape_members` → `PUT /admin/mixtapes/{mixtapeId}/members` (operationId
 * `setMixtapeMembers`).
 *
 * Operator tier (live `requireOperator`). REPLACE the whole tracklist (the
 * editor's drag-reorder). The SAME path as `add_mixtape_members`, distinguished by
 * the PUT method. LOOSE body — `setMixtapeMembers` validates. Preserves
 * `{ mixtape, ok }`.
 */
export const setMixtapeMembers = oc
  .route({
    method: "PUT",
    operationId: "setMixtapeMembers",
    path: "/admin/mixtapes/{mixtapeId}/members",
    summary: "Replace a mixtape's whole tracklist (draft-only)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string() }))
  .output(MixtapeEnvelope);

/**
 * `publish_mixtape` → `POST /admin/mixtapes/{mixtapeId}/publish` (operationId
 * `publishMixtape`).
 *
 * Operator tier (live `requireOperator`). Mint the mixtape (draft → distributing,
 * committing its Log ID). Preserves `{ mixtape, ok }`.
 */
export const publishMixtape = oc
  .route({
    method: "POST",
    operationId: "publishMixtape",
    path: "/admin/mixtapes/{mixtapeId}/publish",
    summary: "Mint a mixtape (publish): commit its Log ID",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
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
 * `mixtapeId` and/or `status` — the SAME read the per-set editor (one mixtape) and
 * the cross-set clip library (all mixtapes) both consume. Preserves `{ clips, ok }`.
 */
export const listClips = oc
  .route({
    method: "GET",
    operationId: "listClips",
    path: "/admin/clips",
    summary: "List clips (optionally filtered by mixtape and/or status)",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string().optional(), status: z.string().optional() }))
  .output(z.object({ clips: z.array(ClipDTOSchema), ok: z.literal(true) }));

/**
 * `create_clip` → `POST /admin/mixtapes/{mixtapeId}/clips` (operationId `createClip`).
 *
 * Operator tier (`requireOperator`). Mint one clip row for a mixtape (the editor
 * queues a cut). LOOSE body — `createClip` validates the cut window + framing.
 * Preserves `{ clip, ok }`.
 */
export const createClip = oc
  .route({
    method: "POST",
    operationId: "createClip",
    path: "/admin/mixtapes/{mixtapeId}/clips",
    summary: "Create a clip for a mixtape (queues a cut)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string() }))
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

/** The `admin-mixtapes` domain's ops, merged into the root contract by `./index.ts`. */
export const adminMixtapesContract = {
  add_mixtape_members: addMixtapeMembers,
  create_clip: createClip,
  create_mixtape: createMixtape,
  delete_clip: deleteClip,
  delete_mixtape: deleteMixtape,
  finalize_clip_cut: finalizeClipCut,
  finalize_mixtape_mixcloud: finalizeMixtapeMixcloud,
  finalize_mixtape_youtube: finalizeMixtapeYoutube,
  get_mixtape_social: getMixtapeSocial,
  initiate_mixtape_youtube: initiateMixtapeYoutube,
  list_clips: listClips,
  list_mixtapes_admin: listMixtapesAdmin,
  presign_clip_upload: presignClipUpload,
  presign_set_video_upload: presignSetVideoUpload,
  publish_mixtape: publishMixtape,
  publish_mixtape_youtube: publishMixtapeYoutube,
  resync_mixtape_youtube: resyncMixtapeYoutube,
  set_mixtape_cues: setMixtapeCues,
  set_mixtape_members: setMixtapeMembers,
  update_clip: updateClip,
  update_mixtape: updateMixtape,
  update_mixtape_cue: updateMixtapeCue,
};
