import { createFileRoute } from "@tanstack/react-router";

import { readCaptions } from "../../../lib/server/captions";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { pushTikTokDraft, pushYouTubeShort } from "../../../lib/server/postiz";
import { upsertPost } from "../../../lib/server/social";
import { ApiError } from "../../../lib/server/spotify";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

// POST /api/admin/tracks/:idOrLogId/social/:platform/draft
// Pushes the track's video + caption (note.txt) to a platform via Postiz. The
// flow is per-platform (see docs/track-lifecycle.md Phase 3):
//   - tiktok  → audio-less cut to the app inbox as a SELF_ONLY DRAFT; the
//               operator adds the official sound + caption and publishes in-app.
//   - youtube → Short uploaded directly (public) with title + custom thumbnail;
//               lands as `published` (Content ID may claim it — accepted).
// Instagram is intentionally absent: no legitimate automated audio path (see
// postiz.ts / docs). The route keeps the `/draft` path for back-compat.
const SUPPORTED = new Set(["tiktok", "youtube"]);

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

        if (!SUPPORTED.has(platform)) {
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

          // video_url is the with-audio review cut (…/footage.mp4); TikTok needs
          // the silent sibling, the direct-post platforms use the audio cut.
          const footage = track.videoUrl;
          // Read the caption from the public note.txt (works in dev too — the
          // VIDEOS binding is an empty local bucket there).
          const captions = await readCaptions([track.logId]);
          const caption = captions[track.logId] ?? "";

          let postId: string;
          let status: "draft" | "published";

          if (platform === "tiktok") {
            const silent = footage.replace(/footage\.mp4$/, "footage-silent.mp4");
            ({ postId } = await pushTikTokDraft({ caption, videoUrl: silent }));
            status = "draft";
          } else {
            const coverUrl = footage.replace(/footage\.mp4$/, "cover.jpg");
            ({ postId } = await pushYouTubeShort({
              coverUrl,
              description: caption,
              title: track.title,
              videoUrl: footage,
            }));
            status = "published";
          }

          await upsertPost(track.trackId, platform, status, postId);

          return Response.json({
            externalId: postId,
            ok: true,
            platform,
            status,
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
