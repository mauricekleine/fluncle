import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse, parseJsonBody } from "../../../lib/server/http-errors";
import { finalizeMixtapeDistribution } from "../../../lib/server/mixtape-social";
import { getMixtapeById } from "../../../lib/server/mixtapes";
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

          // Best-effort custom thumbnail (the wide cover). Self-origin fetch of the
          // cover render: if it loops back to the SPA fallback or returns non-image
          // in the Worker, we log and continue — finalize must not fail on it.
          await trySetThumbnail(request, videoId).catch((error) => {
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

async function trySetThumbnail(request: Request, videoId: string): Promise<void> {
  // Re-read the mixtape just for its committed logId (the finalize call above
  // returned the DTO but we keep the thumbnail path self-contained and tolerant).
  const url = new URL(request.url);
  const mixtapeId = url.pathname.split("/").slice(-2, -1)[0];
  const mixtape = await getMixtapeById(mixtapeId, { includeDrafts: true });

  if (!mixtape.logId) {
    return;
  }

  const coverUrl = `${url.origin}/api/mixtape-cover/${encodeURIComponent(mixtape.logId)}?size=wide`;
  const coverResponse = await fetch(coverUrl);

  if (!coverResponse.ok) {
    throw new Error(`cover render returned ${coverResponse.status}`);
  }

  const contentType = coverResponse.headers.get("content-type") ?? "";

  if (!contentType.startsWith("image/")) {
    // Worker self-origin loop returned HTML (the SPA fallback), not the image.
    throw new Error(`cover render returned non-image content-type "${contentType}"`);
  }

  const image = await coverResponse.arrayBuffer();

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
        "Content-Type": contentType,
      },
      method: "POST",
    },
  );

  if (!setResponse.ok) {
    const detail = (await setResponse.text().catch(() => "")).slice(0, 300);
    throw new Error(`thumbnails.set ${setResponse.status} ${setResponse.statusText}: ${detail}`);
  }
}
