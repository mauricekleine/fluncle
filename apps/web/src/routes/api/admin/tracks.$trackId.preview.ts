import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { jsonError, requireAdmin, requireOperator } from "../../../lib/server/env";
import {
  apiErrorResponse,
  requireParam,
  trackNotFoundResponse,
} from "../../../lib/server/http-errors";
import {
  archivePreviewForTrack,
  getPreviewArchiveMetadata,
} from "../../../lib/server/preview-archive";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

// POST /api/admin/tracks/:idOrLogId/preview — stores one official 30s
// preview at an operator-only archive path for later analysis/model training.
// It is never a playback source and is never exposed through public DTOs.

export const serverHandlers: ApiHandlers = {
  // GET — agent tier: the autonomous render box reads its OWN finding's archived
  // preview key to resolve audio region-independently. Authenticated + non-public,
  // so the Deezer-licensing stance holds (POST/archive stays operator-only below).
  GET: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = requireParam(params.trackId, "trackId");

    try {
      const archive = await getPreviewArchiveMetadata(idOrLogId);

      if (!archive) {
        return trackNotFoundResponse(idOrLogId);
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
      return apiErrorResponse(error);
    }
  },
  POST: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = requireParam(params.trackId, "trackId");

    try {
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        return trackNotFoundResponse(idOrLogId);
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
      return apiErrorResponse(error);
    }
  },
};

function stringField(form: FormData, name: string): string | undefined {
  const value = form.get(name);

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const Route = createFileRoute("/api/admin/tracks/$trackId/preview")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
