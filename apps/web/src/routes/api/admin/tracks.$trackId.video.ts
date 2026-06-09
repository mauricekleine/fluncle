import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { jsonError, requireAdmin } from "../../../lib/server/env";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";
import { updateTrack } from "../../../lib/server/track-update";

// Public base for video reads (R2 custom domain). The Worker owns the bucket;
// the agent uploads here with the admin token and never holds R2 credentials.
const FOUND_BASE = "https://found.fluncle.com";

type Artifact = { contentType: string; field: string; name: string };

// The bundle the ship pipeline produces under out/<log-id>/. review.mp4 is the
// canonical web cut (its URL becomes video_url); the rest are stored alongside.
const ARTIFACTS: Artifact[] = [
  { contentType: "video/mp4", field: "review", name: "review.mp4" },
  { contentType: "video/mp4", field: "social", name: "social.mp4" },
  { contentType: "image/jpeg", field: "poster", name: "poster.jpg" },
  { contentType: "text/plain; charset=utf-8", field: "caption", name: "caption.txt" },
];

// POST /api/admin/tracks/:idOrLogId/video — multipart upload of a track's video
// bundle. Stores each artifact at <log-id>/<name> in R2 and sets video_url to
// the review cut. Requires the track to have a Log ID (one identity everywhere).
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

          for (const artifact of ARTIFACTS) {
            const value = form.get(artifact.field);

            if (!(value instanceof File)) {
              continue;
            }

            const key = `${track.logId}/${artifact.name}`;
            await env.VIDEOS.put(key, await value.arrayBuffer(), {
              httpMetadata: { contentType: artifact.contentType },
            });
            stored[artifact.field] = `${FOUND_BASE}/${key}`;
          }

          if (!stored.review) {
            return jsonError(400, "no_review", "A `review` cut (review.mp4) is required");
          }

          // The review (with-audio) cut is the canonical web video.
          await updateTrack(track.trackId, { videoUrl: stored.review });

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
