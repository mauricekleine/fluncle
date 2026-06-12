import { createFileRoute } from "@tanstack/react-router";

import { FOUND_BASE } from "../../../lib/media";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";
import { updateTrack } from "../../../lib/server/track-update";

// POST /api/admin/tracks/:idOrLogId/video/finalize — phase 2 of the presigned
// flow. After the CLI has PUT each artifact straight to R2, it calls finalize to
// link the canonical web cut: sets video_url to <log-id>/footage.mp4 and stores
// the travelling vehicle (read from the bundle's render.json) as the diversity
// ledger — exactly what the legacy multipart route did after storing.
//
// Requires the track to have a Log ID (one identity everywhere).
export const Route = createFileRoute("/api/admin/tracks/$trackId/video/finalize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        // .../tracks/<idOrLogId>/video/finalize — id is two segments before the tail.
        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        const idOrLogId = parts[parts.length - 3] ?? "";

        try {
          const track = await getTrackByIdOrLogId(idOrLogId);

          if (!track) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          if (!track.logId) {
            return jsonError(
              400,
              "no_log_id",
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            );
          }

          const body = (await request.json().catch(() => undefined)) as
            | { videoVehicle?: unknown }
            | undefined;
          const videoVehicle =
            typeof body?.videoVehicle === "string" && body.videoVehicle.trim()
              ? body.videoVehicle.trim().slice(0, 120)
              : undefined;

          const videoUrl = `${FOUND_BASE}/${track.logId}/footage.mp4`;

          await updateTrack(track.trackId, {
            videoUrl,
            ...(videoVehicle ? { videoVehicle } : {}),
          });

          return Response.json({
            logId: track.logId,
            ok: true,
            trackId: track.trackId,
            videoUrl,
          });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
