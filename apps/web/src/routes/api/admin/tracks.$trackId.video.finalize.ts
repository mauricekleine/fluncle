import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";

import { trackMedia } from "../../../lib/media";
import { requireAdmin } from "../../../lib/server/env";
import {
  apiErrorResponse,
  noLogIdResponse,
  trackNotFoundResponse,
} from "../../../lib/server/http-errors";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";
import { updateTrack } from "../../../lib/server/track-update";

// POST /api/admin/tracks/:idOrLogId/video/finalize — phase 2 of the presigned
// flow. After the CLI has PUT each artifact straight to R2, it calls finalize to
// link the canonical web cut: sets video_url to <log-id>/footage.mp4 and stores
// the travelling vehicle (read from the bundle's render.json) as the diversity
// ledger — exactly what the legacy multipart route did after storing.
//
// Requires the track to have a Log ID (one identity everywhere).
export const serverHandlers: ApiHandlers = {
  POST: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = params.trackId;

    try {
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        return trackNotFoundResponse(idOrLogId);
      }

      if (!track.logId) {
        return noLogIdResponse();
      }

      const body = (await request.json().catch(() => undefined)) as
        | {
            squared?: unknown;
            videoVehicle?: unknown;
            videoModel?: unknown;
            videoModelReasoning?: unknown;
          }
        | undefined;
      const videoVehicle =
        typeof body?.videoVehicle === "string" && body.videoVehicle.trim()
          ? body.videoVehicle.trim().slice(0, 120)
          : undefined;
      const videoModel =
        typeof body?.videoModel === "string" && body.videoModel.trim()
          ? body.videoModel.trim().slice(0, 120)
          : "anthropic/claude-opus-4-8";
      const videoModelReasoning =
        typeof body?.videoModelReasoning === "string" && body.videoModelReasoning.trim()
          ? body.videoModelReasoning.trim().slice(0, 120)
          : "high";

      const videoUrl = trackMedia(track.logId).videoUrl;
      // `squared` (the CLI sends it when it uploaded BOTH the square footage.mp4
      // and the portrait footage.social.mp4) flips the two-master layout on:
      // footage.mp4 is now the clean square crop source. Stamp the signal so the
      // archive surfaces start MT-cropping this finding (docs/video-variants.md).
      const squared = body?.squared === true;

      await updateTrack(track.trackId, {
        videoModel,
        videoModelReasoning,
        videoUrl,
        ...(squared ? { videoSquaredAt: new Date().toISOString() } : {}),
        ...(videoVehicle ? { videoVehicle } : {}),
      });

      return Response.json({
        logId: track.logId,
        ok: true,
        trackId: track.trackId,
        videoUrl,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks/$trackId/video/finalize")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
