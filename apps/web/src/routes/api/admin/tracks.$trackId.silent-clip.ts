import { createFileRoute } from "@tanstack/react-router";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import {
  apiErrorResponse,
  requireParam,
  trackNotFoundResponse,
} from "../../../lib/server/http-errors";
import { trackMedia, videoAudioStripped, videoVersion } from "../../../lib/media";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = requireParam(params.trackId, "trackId");

    try {
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        return trackNotFoundResponse(idOrLogId);
      }

      if (!track.logId) {
        return jsonError(404, "no_log_id", "This finding has no Log ID, so it has no video yet");
      }

      const source = videoAudioStripped(
        trackMedia(track.logId).socialVideoUrl,
        videoVersion(track.videoSquaredAt),
      );
      const upstream = await fetch(source);

      if (!upstream.ok || !upstream.body) {
        return jsonError(
          502,
          "clip_unavailable",
          `The silent clip could not be rendered (upstream ${upstream.status}) — the finding may not have a video yet`,
        );
      }

      return new Response(upstream.body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="fluncle-${track.logId}-silent.mp4"`,
          "Content-Type": upstream.headers.get("Content-Type") ?? "video/mp4",
        },
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks/$trackId/silent-clip")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
