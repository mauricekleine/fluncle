import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";

import { trackMedia, videoAudioStripped } from "../../../lib/media";
import { isPlatform } from "../../../lib/platforms";
import { readCaptions } from "../../../lib/server/captions";
import { jsonError, requireAdmin, requireOperator } from "../../../lib/server/env";
import {
  apiErrorResponse,
  noLogIdResponse,
  requireParam,
  trackNotFoundResponse,
} from "../../../lib/server/http-errors";
import { pushTikTokDraft, pushYouTubeShort, resolveYouTubeUrl } from "../../../lib/server/postiz";
import { hasPostAwaitingUrl, recordPostUrl, upsertPost } from "../../../lib/server/social";
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
//
// Supported platforms + the `isPlatform` guard are derived from PLATFORMS
// (lib/platforms.ts, the single source of truth) — a new push target appears
// here for free, and the exhaustive switch below makes the build fail until its
// branch is added.

export const serverHandlers: ApiHandlers = {
  POST: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = requireParam(params.trackId, "trackId");
    const platform = requireParam(params.platform, "platform");

    if (!isPlatform(platform)) {
      return jsonError(400, "unsupported_platform", `Unsupported platform: ${platform}`);
    }

    // tiktok is a SELF_ONLY inbox draft (still needs a human to publish in-app),
    // so the agent role may push it. youtube is a direct PUBLIC upload — operator
    // only.
    if (platform === "youtube") {
      const notOperator = await requireOperator(request);

      if (notOperator) {
        return notOperator;
      }

      // The push gate: block a new YouTube push while any finding is still
      // "pushed but no URL" for YouTube. The live URL resolves from Postiz
      // `/missing` by matching the newest published item, so a second pending
      // upload would make that match ambiguous. Keep exactly one in flight.
      if (await hasPostAwaitingUrl("youtube")) {
        return jsonError(
          409,
          "youtube_url_pending",
          "A YouTube post is still awaiting its URL — record it first (or run the URL resolver), then push the next one.",
        );
      }
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

      // The PLAYABLE portrait cut both platforms push (docs/video-variants.md):
      // under the two-master layout (videoSquaredAt set) that is the baked-text
      // footage.social.mp4 — footage.mp4 is the clean square crop source, NOT a
      // social cut. A legacy finding (no signal) keeps pushing footage.mp4, which
      // is still its portrait+text cut, so un-migrated tracks are unaffected.
      const media = trackMedia(track.logId);
      const social = track.videoSquaredAt ? media.socialVideoUrl : media.videoUrl;
      // Read the caption from the public note.txt (works in dev too — the
      // VIDEOS binding is an empty local bucket there).
      const captions = await readCaptions([track.logId]);
      const caption = captions[track.logId] ?? "";

      // The push shape per platform. The switch is exhaustive over `Platform`:
      // a new push target added to PLATFORMS without a branch here fails the
      // build (the `never` default), instead of silently 400-ing at runtime.
      let postId: string;
      let status: "draft" | "published";

      switch (platform) {
        case "tiktok": {
          // Silent so the operator attaches the licensed sound in-app. Two-master:
          // strip audio off the social cut via MT (footage-silent.mp4 is retired).
          // Legacy: the stored footage-silent.mp4 sibling.
          const silent = track.videoSquaredAt
            ? videoAudioStripped(social)
            : social.replace(/footage\.mp4$/, "footage-silent.mp4");
          ({ postId } = await pushTikTokDraft({ caption, videoUrl: silent }));
          status = "draft";
          break;
        }
        case "youtube": {
          ({ postId } = await pushYouTubeShort({
            coverUrl: media.coverUrl,
            description: caption,
            title: track.title,
            videoUrl: social,
          }));
          status = "published";
          break;
        }
        default: {
          // Exhaustiveness gate: if `platform` is ever widened past the handled
          // cases this stops type-checking (assigning a non-`never` to `never`),
          // so a new push target can't silently fall through here at runtime.
          const unreachable: never = platform;

          void unreachable;

          return jsonError(400, "unsupported_platform", "Unsupported platform");
        }
      }

      await upsertPost(track.trackId, platform, status, postId);

      // Auto-record the live YouTube URL: Postiz returns only its own postId on
      // create, so poll `/missing` (the publish is async) and store the newest
      // YouTube permalink on the row — surfaced via the social list. Best-effort
      // and coverless: on a miss the url stays null and the operator's manual
      // "Update URL" is the fallback (the push gate holds the next push until set).
      if (platform === "youtube") {
        const resolved = await resolveYouTubeUrl(postId);

        if (resolved) {
          await recordPostUrl(track.trackId, platform, resolved);
        }
      }

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
