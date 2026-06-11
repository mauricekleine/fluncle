import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { jsonError, requireAdmin } from "../../../lib/server/env";
import {
  archivePreviewForTrack,
  getPreviewArchiveMetadata,
} from "../../../lib/server/preview-archive";
import { ApiError } from "../../../lib/server/spotify";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

// POST /api/admin/tracks/:idOrLogId/preview-archive — stores one official 30s
// preview at an operator-only archive path for later analysis/model training.
// It is never a playback source and is never exposed through public DTOs.
export const Route = createFileRoute("/api/admin/tracks/$trackId/preview-archive")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        const idOrLogId = idSegment(request.url);

        try {
          const archive = await getPreviewArchiveMetadata(idOrLogId);

          if (!archive) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          return Response.json({
            archived: Boolean(archive.key),
            archivedAt: archive.archivedAt || undefined,
            key: archive.key || undefined,
            logId: archive.logId,
            mime: archive.mime || undefined,
            ok: true,
            source: archive.source || undefined,
            trackId: archive.trackId,
          });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
      POST: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        const idOrLogId = idSegment(request.url);

        try {
          const track = await getTrackByIdOrLogId(idOrLogId);

          if (!track) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          const form = await request.formData();
          const file = form.get("preview");
          const source = stringField(form, "source");
          const mime = stringField(form, "mime") ?? (file instanceof File ? file.type : undefined);

          if (!(file instanceof File)) {
            return jsonError(400, "no_preview", "A `preview` file is required");
          }

          if (!source) {
            return jsonError(400, "no_source", "A preview `source` field is required");
          }

          if (!mime) {
            return jsonError(400, "no_mime", "A preview `mime` field is required");
          }

          const archive = await archivePreviewForTrack({
            bucket: env.VIDEOS,
            bytes: await file.arrayBuffer(),
            mime,
            source,
            track,
          });

          return Response.json({
            ...archive,
            logId: track.logId,
            ok: true,
            trackId: track.trackId,
          });
        } catch (error) {
          if (error instanceof ApiError) {
            return jsonError(error.status, error.code, error.message);
          }

          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});

function idSegment(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);

  return parts[parts.length - 2] ?? "";
}

function stringField(form: FormData, name: string): string | undefined {
  const value = form.get(name);

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
