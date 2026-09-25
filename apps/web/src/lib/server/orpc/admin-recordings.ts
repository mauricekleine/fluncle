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

export function adminRecordingsHandlers(os: Implementer) {
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

  const getRecordingHandler = os.get_recording.use(adminAuth).handler(async ({ input }) => {
    try {
      return { ok: true as const, recording: await getRecording(input.recordingId) };
    } catch (error) {
      throw apiFault(error);
    }
  });

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
