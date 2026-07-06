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

// GET /api/admin/tracks/:idOrLogId/silent-clip — a same-origin download proxy for
// the AUDIO-STRIPPED portrait social cut (the silent clip the TikTok push normally
// sends, so the operator attaches the licensed sound in-app). The bytes are
// produced on the fly by Cloudflare Media Transformations off `footage.social.mp4`
// (`videoAudioStripped`), which lives on the found.fluncle.com zone — a DIFFERENT
// origin from the admin app, so a client-side `<a download>` is ignored by the
// browser and the clip only ever opens inline. Streaming it back through this
// same-origin route with `Content-Disposition: attachment` is the only way to force
// a clean download — the manual fallback when Postiz's TikTok push is down.

export const serverHandlers: ApiHandlers = {
  // Admin tier: matches the sibling preview GET. The clip is derived from the
  // already-public found.fluncle.com master, so this only adds a download wrapper.
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

      // Stream the body straight through (no buffering) and re-clothe it as an
      // attachment. The filename carries the Log ID so downloads stay identifiable.
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
