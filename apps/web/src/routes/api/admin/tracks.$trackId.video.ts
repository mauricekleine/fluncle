import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { FOUND_BASE } from "../../../lib/media";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";
import { updateTrack } from "../../../lib/server/track-update";
import {
  VIDEO_ARTIFACTS,
  modelFromRenderJson,
  vehicleFromRenderJson,
} from "../../../lib/server/video-bundle";

// FOUND_BASE (the R2 custom-domain read base) is shared from lib/media — the
// Worker owns the bucket; the agent uploads with the admin token, never holds R2
// credentials.

// POST /api/admin/tracks/:idOrLogId/video — multipart upload of a track's video
// bundle. Stores each artifact at <log-id>/<name> in R2 and sets video_url to
// the review cut. Requires the track to have a Log ID (one identity everywhere).
//
// This is the SMALL-BUNDLE fallback: it streams the whole bundle through the
// Worker, so Cloudflare's ~100MB edge body limit caps it. Large (crf-20) cuts
// use the presigned direct-to-R2 flow at .../video/uploads + .../video/finalize.
export const Route = createFileRoute("/api/admin/tracks/$trackId/video")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        // .../tracks/<idOrLogId>/video — the id is the segment before "video".
        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        const idOrLogId = parts[parts.length - 2] ?? "";

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

          const form = await request.formData();
          const stored: Record<string, string> = {};
          let videoVehicle: string | undefined;
          let videoModel: string | undefined;

          for (const artifact of VIDEO_ARTIFACTS) {
            const value = form.get(artifact.field);

            if (!(value instanceof File)) {
              continue;
            }

            const bytes = await value.arrayBuffer();
            const key = `${track.logId}/${artifact.name}`;
            await env.VIDEOS.put(key, bytes, {
              httpMetadata: { contentType: artifact.contentType },
            });
            stored[artifact.field] = `${FOUND_BASE}/${key}`;

            if (artifact.field === "render") {
              const renderJson = new TextDecoder().decode(bytes);
              videoVehicle = vehicleFromRenderJson(renderJson);
              videoModel = modelFromRenderJson(renderJson);
            }
          }

          if (!stored.footage) {
            return jsonError(400, "no_footage", "A `footage` cut (footage.mp4) is required");
          }

          // The footage (with-audio) cut is the canonical web video; the vehicle
          // (when present) joins it as the diversity-ledger entry, and the
          // authoring model defaults when render.json omits it.
          await updateTrack(track.trackId, {
            videoModel: videoModel ?? "anthropic/claude-opus-4-8",
            videoUrl: stored.footage,
            ...(videoVehicle ? { videoVehicle } : {}),
          });

          return Response.json({
            logId: track.logId,
            ok: true,
            trackId: track.trackId,
            urls: stored,
          });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
