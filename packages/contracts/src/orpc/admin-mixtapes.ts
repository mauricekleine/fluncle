import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  ClipDTOSchema,
  MixtapeDTOSchema,
  MixtapeSocialPostItemSchema,
  UploadContentTypeSchema,
} from "./_shared";

const MixtapeEnvelope = z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true) });

const ClipEnvelope = z.object({ clip: ClipDTOSchema, ok: z.literal(true) });

export const listMixtapesAdmin = oc
  .route({
    method: "GET",
    operationId: "listMixtapesAdmin",
    path: "/admin/mixtapes",
    summary: "List every mixtape (hydrated, including distributing)",
    tags: ["Admin"],
  })
  .output(z.object({ mixtapes: z.array(MixtapeDTOSchema), ok: z.literal(true) }));

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

export const announceMixtape = oc
  .route({
    method: "POST",
    operationId: "announceMixtape",
    path: "/admin/mixtapes/{mixtapeId}/announce",
    summary: "Announce a published mixtape to the crew (the Telegram crew channel)",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(z.object({ message: z.string(), mixtape: MixtapeDTOSchema, ok: z.literal(true) }));

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
      contentType: UploadContentTypeSchema.optional(),
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

export const presignClipUpload = oc
  .route({
    method: "POST",
    operationId: "presignClipUpload",

    path: "/admin/clips/{clipId}/cut/presign",
    summary: "Presign a single-PUT direct-to-R2 upload for a clip's cut output",
    tags: ["Admin"],
  })
  .input(z.looseObject({ clipId: z.string(), contentType: UploadContentTypeSchema.optional() }))
  .output(
    z.object({
      clipId: z.string(),
      contentType: z.string(),
      key: z.string(),
      ok: z.literal(true),
      url: z.string(),
    }),
  );

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

      captured: z.number(),
      failed: z.number(),
      ok: z.literal(true),

      paused: z.boolean(),
      posted: z.number(),

      skippedBlank: z.number(),

      skippedCapped: z.number(),
    }),
  );

export const listClipPosts = oc
  .route({
    method: "GET",
    operationId: "listClipPosts",
    path: "/admin/clips/social",
    summary: "List every clip's Instagram drip-feed schedule + status",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), posts: z.array(ClipSocialPostSchema) }));

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

export const adminMixtapesContract = {
  announce_mixtape: announceMixtape,
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
};
