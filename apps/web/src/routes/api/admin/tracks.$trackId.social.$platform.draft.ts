import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";

import { readCaptions } from "../../../lib/server/captions";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import {
  apiErrorResponse,
  noLogIdResponse,
  trackNotFoundResponse,
} from "../../../lib/server/http-errors";
import { pushTikTokDraft, pushYouTubeShort } from "../../../lib/server/postiz";
import { upsertPost } from "../../../lib/server/social";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

// POST /api/admin/tracks/:idOrLogId/social/:platform/draft
// Pushes the track's video + caption (note.txt) to a platform via Postiz. The
// flow is per-platform (see docs/track-lifecycle.md Phase 3):
//   - tiktok  → audio-less cut to the app inbox as a SELF_ONLY DRAFT; the
//               operator adds the official sound + caption and publishes in-app.
//   - youtube → Short uploaded directly (public) with title + custom thumbnail;
//               lands as `published` (Content ID may claim it — accepted).
// Instagram is intentionally absent: no legitimate automated audio path (see
// postiz.ts / docs). The `/draft` verb is TikTok-shaped; it is the single push
// endpoint, not a back-compat path.
const SUPPORTED = new Set(["tiktok", "youtube"]);

export const serverHandlers: ApiHandlers = {
  POST: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = params.trackId;
    const platform = params.platform;

    if (!SUPPORTED.has(platform)) {
      return jsonError(400, "unsupported_platform", `Unsupported platform: ${platform}`);
    }

    try {
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        return trackNotFoundResponse(idOrLogId);
      }

      if (!track.logId) {
        return noLogIdResponse();
      }

      if (!track.videoUrl) {
        return jsonError(400, "no_video", "Track has no video; render + upload it first");
      }

      // video_url is the with-audio review cut (…/footage.mp4). TikTok needs
      // the silent sibling; YouTube uses the audio cut + the cover thumbnail.
      // Derive all three from the STORED video_url so they agree even when a
      // row's video_url is non-canonical (the silent/cover siblings ride
      // alongside the footage by convention — same path, different filename).
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
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks/$trackId/social/$platform/draft")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
