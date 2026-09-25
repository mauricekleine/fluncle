import { oc } from "@orpc/contract";
import * as z from "zod";
import { RecordingDTOSchema, UploadContentTypeSchema } from "./_shared";

const RecordingEnvelope = z.object({ ok: z.literal(true), recording: RecordingDTOSchema });

export const createRecording = oc
  .route({
    method: "POST",
    operationId: "createRecording",
    path: "/admin/recordings",
    summary: "Create a recording (a captured, un-promoted set)",
    tags: ["Admin"],
  })
  .input(z.looseObject({}))
  .output(RecordingEnvelope);

export const listRecordings = oc
  .route({
    method: "GET",
    operationId: "listRecordings",
    path: "/admin/recordings",
    summary: "List every recording (optionally filtered by kind=plan|take and/or parentId)",
    tags: ["Admin"],
  })
  .input(z.object({ kind: z.string().optional(), parentId: z.string().optional() }))
  .output(z.object({ ok: z.literal(true), recordings: z.array(RecordingDTOSchema) }));

export const getRecording = oc
  .route({
    method: "GET",
    operationId: "getRecording",
    path: "/admin/recordings/{recordingId}",
    summary: "Show one recording by id",
    tags: ["Admin"],
  })
  .input(z.object({ recordingId: z.string() }))
  .output(RecordingEnvelope);

export const updateRecording = oc
  .route({
    method: "PATCH",
    operationId: "updateRecording",
    path: "/admin/recordings/{recordingId}",
    summary: "Update a recording's title, recorded date, or tracklist",
    tags: ["Admin"],
  })
  .input(z.looseObject({ recordingId: z.string() }))
  .output(RecordingEnvelope);

export const deleteRecording = oc
  .route({
    method: "DELETE",
    operationId: "deleteRecording",
    path: "/admin/recordings/{recordingId}",
    summary: "Delete a recording (cascade its clips)",
    tags: ["Admin"],
  })
  .input(z.object({ recordingId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const presignRecordingUpload = oc
  .route({
    method: "POST",
    operationId: "presignRecordingUpload",
    path: "/admin/recordings/{recordingId}/set-video/presign",
    summary: "Open + presign a multipart direct-to-R2 upload for a recording's set video",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      contentType: UploadContentTypeSchema.optional(),
      partCount: z.unknown().optional(),
      recordingId: z.string(),
    }),
  )
  .output(
    z.object({
      abortUrl: z.string(),
      completeUrl: z.string(),
      key: z.string(),
      ok: z.literal(true),
      parts: z.array(z.object({ partNumber: z.number(), url: z.string() })),
      recordingId: z.string(),
      uploadId: z.string(),
    }),
  );

export const promoteRecording = oc
  .route({
    method: "POST",
    operationId: "promoteRecording",
    path: "/admin/recordings/{recordingId}/promote",
    summary: "Promote a recording to a published mixtape (mint-or-reuse; idempotent)",
    tags: ["Admin"],
  })
  .input(z.object({ recordingId: z.string() }))
  .output(RecordingEnvelope);

export const replaceRecordingCues = oc
  .route({
    method: "PUT",
    operationId: "replaceRecordingCues",
    path: "/admin/recordings/{recordingId}/cues",
    summary: "Replace a recording's cue tracklist (the Rekordbox-derivation write target)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ cues: z.unknown().optional(), recordingId: z.string() }))
  .output(RecordingEnvelope);

export const adminRecordingsContract = {
  create_recording: createRecording,
  delete_recording: deleteRecording,
  get_recording: getRecording,
  list_recordings: listRecordings,
  presign_recording_upload: presignRecordingUpload,
  promote_recording: promoteRecording,
  replace_recording_cues: replaceRecordingCues,
  update_recording: updateRecording,
};
