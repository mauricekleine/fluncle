import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { listMixtapeSocialPosts } from "../../../lib/server/mixtape-social";
import { ApiError } from "../../../lib/server/spotify";
import { getYouTubeAccessToken } from "../../../lib/server/youtube";

// The recurring human gate: flip the unlisted mixtape video to public. Server-side
// videos.update (the Worker holds the refresh token via youtube_auth), so neither
// the CLI nor the dashboard needs a local file or a token. Resolves the video id
// from the mixtape's youtube distribution row.

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/youtube/publish")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const posts = await listMixtapeSocialPosts(params.mixtapeId);
          const youtube = posts.find((post) => post.platform === "youtube");
          const videoId = youtube?.externalId;

          if (!videoId) {
            throw new ApiError(
              "youtube_not_distributed",
              "No YouTube video to publish — distribute the mixtape first",
              409,
            );
          }

          const accessToken = await getYouTubeAccessToken();
          const response = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
            // videos.update REPLACES the whole status part — fields omitted here
            // get reset to defaults, so we resend selfDeclaredMadeForKids to match
            // the insert (omitting it makes YouTube reject the update).
            body: JSON.stringify({
              id: videoId,
              status: {
                privacyStatus: "public",
                selfDeclaredMadeForKids: false,
              },
            }),
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            method: "PUT",
          });

          if (!response.ok) {
            const detail = (await response.text().catch(() => "")).slice(0, 500);
            throw new ApiError(
              "youtube_publish_failed",
              `YouTube rejected the visibility flip (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
              502,
            );
          }

          const url = youtube.url ?? `https://youtu.be/${videoId}`;

          return Response.json({ ok: true, url });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});

export const serverHandlers = Route.options.server!.handlers;
