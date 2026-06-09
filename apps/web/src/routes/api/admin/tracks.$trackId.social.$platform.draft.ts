import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { jsonError, requireAdmin } from "../../../lib/server/env";
import { pushTikTokDraft } from "../../../lib/server/postiz";
import { upsertDraft } from "../../../lib/server/social";
import { ApiError } from "../../../lib/server/spotify";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

// POST /api/admin/tracks/:idOrLogId/social/:platform/draft
// Pushes the track's audio-less cut + note (caption) to the platform as a DRAFT
// (TikTok inbox via Postiz), then records social_posts(platform, draft). The
// operator adds the official sound + publishes in-app, then reports status back.
export const Route = createFileRoute("/api/admin/tracks/$trackId/social/$platform/draft")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        // .../tracks/<idOrLogId>/social/<platform>/draft
        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        const idOrLogId = parts[parts.length - 4] ?? "";
        const platform = parts[parts.length - 2] ?? "";

        if (platform !== "tiktok") {
          return jsonError(400, "unsupported_platform", `Unsupported platform: ${platform}`);
        }

        try {
          const track = await getTrackByIdOrLogId(idOrLogId);

          if (!track) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          if (!track.logId) {
            return jsonError(400, "no_log_id", "Track has no Log ID");
          }

          if (!track.videoUrl) {
            return jsonError(400, "no_video", "Track has no video; render + upload it first");
          }

          // TikTok gets the audio-less cut; the operator adds the official sound in-app.
          const videoUrl = track.videoUrl.replace(/footage\.mp4$/, "footage-silent.mp4");
          const noteObject = await env.VIDEOS.get(`${track.logId}/note.txt`);
          const caption = noteObject ? await noteObject.text() : "";

          const { postId } = await pushTikTokDraft({ caption, videoUrl });
          await upsertDraft(track.trackId, platform, postId);

          return Response.json({
            externalId: postId,
            ok: true,
            platform,
            status: "draft",
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
