import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse, parseJsonBody } from "../../../lib/server/http-errors";
import { renderMixtapeCover } from "../../../lib/server/mixtape-cover";
import { finalizeMixtapeDistribution } from "../../../lib/server/mixtape-social";
import { ApiError } from "../../../lib/server/spotify";
import { getYouTubeAccessToken } from "../../../lib/server/youtube";

// YouTube's thumbnail cap. The wide (1280×720) cover PNG is well under this; we
// verify anyway so an oversized render is skipped rather than rejected by YouTube.
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

// Step 3 of the YouTube upload: the CLI has finished the resumable PUT and reports
// the videoId. We record the post as published, dual-write mixtapes.youtube_url,
// flip distributing→published on the first link, and best-effort set the custom
// thumbnail from the on-the-fly cover. A thumbnail failure never fails finalize —
// the unlisted video is already live with its real coordinate.
export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/youtube/finalize")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const parsed = await parseJsonBody(request);

          if (parsed instanceof Response) {
            return parsed;
          }

          const body = parsed.json as { videoId?: unknown };
          const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";

          if (!videoId) {
            throw new ApiError("invalid_request", "videoId is required", 400);
          }

          const mixtape = await finalizeMixtapeDistribution(params.mixtapeId, "youtube", {
            externalId: videoId,
            url: `https://youtu.be/${videoId}`,
          });

          // Best-effort custom thumbnail (the wide cover, rendered in-process — a
          // Worker can't HTTP-fetch its own cover route without looping to the SPA
          // fallback). A thumbnail failure must not fail finalize; the unlisted video
          // is already live with its real coordinate.
          await trySetThumbnail(mixtape.logId, videoId).catch((error) => {
            console.warn(
              `[mixtape ${params.mixtapeId}] YouTube thumbnail set failed (non-fatal):`,
              error instanceof Error ? error.message : String(error),
            );
          });

          return Response.json({ mixtape, ok: true, platform: "youtube" });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});

async function trySetThumbnail(logId: string | undefined, videoId: string): Promise<void> {
  if (!logId) {
    return;
  }

  // Render the wide cover IN-PROCESS (no HTTP self-fetch — that loops to the SPA
  // fallback in the Worker and the thumbnail silently never attaches).
  const cover = await renderMixtapeCover(logId, "wide");

  if (!cover) {
    return;
  }

  const image = await cover.arrayBuffer();

  if (image.byteLength > THUMBNAIL_MAX_BYTES) {
    throw new Error(`cover PNG is ${image.byteLength} bytes (> 2MB cap)`);
  }

  const accessToken = await getYouTubeAccessToken();
  const setResponse = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
    {
      body: image,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "image/png",
      },
      method: "POST",
    },
  );

  if (!setResponse.ok) {
    const detail = (await setResponse.text().catch(() => "")).slice(0, 300);
    throw new Error(`thumbnails.set ${setResponse.status} ${setResponse.statusText}: ${detail}`);
  }
}
