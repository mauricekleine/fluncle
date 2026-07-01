// The `admin-recordings` domain contract module — the RFC recording-primitive
// (Design B) control plane. A RECORDING is a captured DJ set that is NOT (yet) a
// published mixtape: it OWNS its R2 key, carries an optional cue tracklist, and is
// COORDINATE-LESS until `promote` mints a mixtape from it. The clip pipeline cuts
// clips from a recording's set video without minting a scarce Log ID coordinate.
//
// Built on the same pattern as `./admin-mixtapes.ts`. Mutating bodies stay LOOSE/
// passthrough by design — the live routes pass the raw JSON to the server helpers
// (`createRecording`/`updateRecording`), which validate + throw their own codes — so
// the contract must not pre-reject.
//
// VERIFIED auth tiers against the live handlers:
//   - `list_recordings` (GET) + `get_recording` (GET) — admin tier (agent-allowed reads).
//   - everything else — operator tier: create/update/delete, the upload presign, and
//     `promote` (it mints a scarce coordinate), so the agent token 403s.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { RecordingDTOSchema } from "./_shared";

/** The `{ ok, recording }` envelope the recording writes + reads return. */
const RecordingEnvelope = z.object({ ok: z.literal(true), recording: RecordingDTOSchema });

/**
 * `create_recording` → `POST /admin/recordings` (operationId `createRecording`).
 *
 * Operator tier. Mint a coordinate-less recording row (its R2 key is derived from the
 * new id). LOOSE body — `createRecording` validates `title`/`recordedAt`. The set video
 * is presigned + uploaded separately. Preserves `{ ok, recording }`.
 */
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

/**
 * `list_recordings` → `GET /admin/recordings` (operationId `listRecordings`).
 *
 * Admin tier (agent-allowed read). Every recording, newest first. Preserves
 * `{ ok, recordings }`.
 */
export const listRecordings = oc
  .route({
    method: "GET",
    operationId: "listRecordings",
    path: "/admin/recordings",
    summary: "List every recording",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), recordings: z.array(RecordingDTOSchema) }));

/**
 * `get_recording` → `GET /admin/recordings/{recordingId}` (operationId `getRecording`).
 *
 * Admin tier (agent-allowed read — the box's clip-cut cron resolves a clip's recording
 * here). Preserves `{ ok, recording }`.
 */
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

/**
 * `update_recording` → `PATCH /admin/recordings/{recordingId}` (operationId
 * `updateRecording`).
 *
 * Operator tier. Edit `title`/`recordedAt`/the whole `tracklistJson` cue array. LOOSE
 * body — `updateRecording` validates. Preserves `{ ok, recording }`.
 */
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

/**
 * `delete_recording` → `DELETE /admin/recordings/{recordingId}` (operationId
 * `deleteRecording`).
 *
 * Operator tier. Drop a recording + cascade its `mixtape_clips`. Preserves `{ ok }`.
 */
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

/**
 * `presign_recording_upload` → `POST /admin/recordings/{recordingId}/set-video/presign`
 * (operationId `presignRecordingUpload`).
 *
 * Operator tier. The `presign_set_video_upload` clone targeting the recording's OWNED
 * key `recordings/<recordingId>/set.mp4`: open a multipart direct-to-R2 upload + presign
 * every leg (one PUT URL per part + the complete/abort URLs). The rendition is ~1.5GB —
 * past the single-PUT budget — so the CLI streams the parts straight to R2. LOOSE body —
 * the handler validates `partCount`. Returns `{ ok, recordingId, key, uploadId, parts,
 * completeUrl, abortUrl }`.
 */
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
      contentType: z.unknown().optional(),
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

/**
 * `promote_recording` → `POST /admin/recordings/{recordingId}/promote` (operationId
 * `promoteRecording`).
 *
 * Operator tier — it mints a scarce Log ID coordinate. IDEMPOTENT (mint-or-reuse): if
 * the recording already links a mixtape, reuse it (NEVER re-mint); else create + mint a
 * mixtape, copy the set video to `<logId>/set.mp4`, seed the tracklist, flip setVideoAt,
 * repoint the recording's r2Key, and delete the old key last (best-effort). Returns the
 * recording after promotion (now carrying `logId` + `mixtapeId`). Preserves
 * `{ ok, recording }`.
 */
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

/** The `admin-recordings` domain's ops, merged into the root contract by `./index.ts`. */
export const adminRecordingsContract = {
  create_recording: createRecording,
  delete_recording: deleteRecording,
  get_recording: getRecording,
  list_recordings: listRecordings,
  presign_recording_upload: presignRecordingUpload,
  promote_recording: promoteRecording,
  update_recording: updateRecording,
};
