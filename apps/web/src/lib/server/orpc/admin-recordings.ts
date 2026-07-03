// The `admin-recordings` domain router module — the RFC recording-primitive (Design B)
// control plane. Each handler is a thin wrapper over the `../recordings` data layer; the
// auth tier lives on the oRPC procedure middleware (../orpc-auth).
//
// VERIFIED auth tiers:
//   - `list_recordings` / `get_recording` — admin tier (`adminAuth`): agent-allowed reads
//     (the box's clip-cut cron resolves a clip's recording via `get_recording`).
//   - everything else — operator tier (`adminAuth` + `operatorGuard`): create/update/
//     delete, the upload presign, and `promote` (it mints a scarce coordinate).

import { ORPCError } from "@orpc/server";
import {
  createRecording,
  deleteRecording,
  getRecording,
  listRecordings,
  promoteRecording,
  replaceRecordingCues,
  updateRecording,
} from "../recordings";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { R2_MAX_PARTS, VIDEOS_BUCKET, presignMultipartUpload } from "../r2-presign";
import { apiFault, type Implementer, toFault } from "./_shared";

/** Build the `admin-recordings` domain's handlers. */
export function adminRecordingsHandlers(os: Implementer) {
  // POST /admin/recordings — operator tier. LOOSE body → createRecording.
  const createRecordingHandler = os.create_recording
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, recording: await createRecording(input) };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // GET /admin/recordings — admin tier (agent-allowed read). Optionally filtered by the
  // plan/take split (`kind=plan|take`) and/or one plan's takes (`parentId`).
  const listRecordingsHandler = os.list_recordings.use(adminAuth).handler(async ({ input }) => {
    try {
      const kind = input.kind === "plan" || input.kind === "take" ? input.kind : undefined;

      return {
        ok: true as const,
        recordings: await listRecordings({ kind, parentId: input.parentId }),
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/recordings/{recordingId} — admin tier (agent-allowed read).
  const getRecordingHandler = os.get_recording.use(adminAuth).handler(async ({ input }) => {
    try {
      return { ok: true as const, recording: await getRecording(input.recordingId) };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // PATCH /admin/recordings/{recordingId} — operator tier. LOOSE body → updateRecording.
  const updateRecordingHandler = os.update_recording
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { recordingId, ...body } = input;

        return { ok: true as const, recording: await updateRecording(recordingId, body) };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // DELETE /admin/recordings/{recordingId} — operator tier (cascade its clips).
  const deleteRecordingHandler = os.delete_recording
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await deleteRecording(input.recordingId);

        return { ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/recordings/{recordingId}/set-video/presign — operator tier. The
  // `presign_set_video_upload` clone: open a multipart direct-to-R2 upload targeting the
  // recording's OWNED key `recordings/<id>/set.mp4` + presign every leg; the CLI streams
  // the ~1.5GB rendition straight to R2.
  const presignRecordingUploadHandler = os.presign_recording_upload
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const partCount = Number(input.partCount);

        if (!Number.isInteger(partCount) || partCount < 1 || partCount > R2_MAX_PARTS) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "invalid_request",
              apiMessage: `partCount must be an integer 1..${R2_MAX_PARTS}`,
            },
            message: `partCount must be an integer 1..${R2_MAX_PARTS}`,
            status: 400,
          });
        }

        const contentType =
          typeof input.contentType === "string" && input.contentType
            ? input.contentType
            : "video/mp4";

        // The recording OWNS its key — read it off the row (getRecording throws
        // `recording_not_found`/404 if it's gone). A PLAN owns no key yet (r2Key
        // NULL since the plan→recording→mixtape Deploy-1); attaching a take to a
        // plan is a later slice, so presigning one is a clean 409 for now.
        const recording = await getRecording(input.recordingId);

        if (!recording.r2Key) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "recording_has_no_video",
              apiMessage:
                "This recording is a plan (no owned video key) — create a recording to upload a take",
            },
            message:
              "This recording is a plan (no owned video key) — create a recording to upload a take",
            status: 409,
          });
        }

        const presign = await presignMultipartUpload(
          VIDEOS_BUCKET,
          recording.r2Key,
          contentType,
          partCount,
        );

        return {
          abortUrl: presign.abortUrl,
          completeUrl: presign.completeUrl,
          key: presign.key,
          ok: true as const,
          parts: presign.parts,
          recordingId: input.recordingId,
          uploadId: presign.uploadId,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/recordings/{recordingId}/promote — operator tier (it mints a coordinate).
  // Idempotent mint-or-reuse; re-runnable end to end.
  const promoteRecordingHandler = os.promote_recording
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, recording: await promoteRecording(input.recordingId) };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // PUT /admin/recordings/{recordingId}/cues — operator tier. Transactionally replace
  // the recording's whole cue set from the body's ordered `cues` array (the Rekordbox
  // derivation write target). LOOSE body → replaceRecordingCues validates each cue.
  const replaceRecordingCuesHandler = os.replace_recording_cues
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const cues = Array.isArray(input.cues) ? input.cues : [];

        return {
          ok: true as const,
          recording: await replaceRecordingCues(input.recordingId, cues),
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    create_recording: createRecordingHandler,
    delete_recording: deleteRecordingHandler,
    get_recording: getRecordingHandler,
    list_recordings: listRecordingsHandler,
    presign_recording_upload: presignRecordingUploadHandler,
    promote_recording: promoteRecordingHandler,
    replace_recording_cues: replaceRecordingCuesHandler,
    update_recording: updateRecordingHandler,
  };
}
