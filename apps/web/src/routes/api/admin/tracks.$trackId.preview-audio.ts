import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";
import { getPreviewArchiveMetadata } from "../../../lib/server/preview-archive";

export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = requireParam(params.trackId, "trackId");

    try {
      const archive = await getPreviewArchiveMetadata(idOrLogId);

      if (!archive) {
        return jsonError(404, "track_not_found", `No finding matches "${idOrLogId}"`);
      }

      if (!archive.key) {
        return jsonError(
          404,
          "preview_unarchived",
          "This finding has no archived preview audio yet",
        );
      }

      const object = await env.SOURCE_AUDIO.get(archive.key);

      if (!object) {
        return jsonError(
          404,
          "preview_audio_missing",
          "The archived preview audio is no longer in R2",
        );
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      if (archive.mime) {
        headers.set("Content-Type", archive.mime);
      }
      headers.set("Content-Length", String(object.size));
      headers.set("Cache-Control", "no-store");

      return new Response(object.body, { headers });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks/$trackId/preview-audio")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
