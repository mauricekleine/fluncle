import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, parseJsonBody } from "../../../lib/server/http-errors";
import { youtubeDescription } from "../../../lib/mixtape-chapters";
import { getMixtapeById } from "../../../lib/server/mixtapes";
import { ApiError } from "../../../lib/server/spotify";
import { getYouTubeAccessToken } from "../../../lib/server/youtube";

// Step 1 of the YouTube resumable upload (corrected per the RFC: the data PUT is
// NOT self-authorizing). The Worker builds the snippet/description/chapters from
// the COMMITTED coordinate, opens a resumable session, and hands the CLI BOTH the
// session URI and a short-lived access token for the PUT. The CLI moves the bytes
// (the Worker can't proxy multi-GB media).

export const serverHandlers: ApiHandlers = {
  POST: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const parsed = await parseJsonBody(request);

      if (parsed instanceof Response) {
        return parsed;
      }

      const body = parsed.json as { contentLength?: unknown; contentType?: unknown };
      const contentLength = Number(body.contentLength);
      const contentType =
        typeof body.contentType === "string" && body.contentType ? body.contentType : "video/mp4";

      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        throw new ApiError("invalid_request", "contentLength must be a positive number", 400);
      }

      const mixtape = await getMixtapeById(params.mixtapeId, { includeDrafts: true });

      if (mixtape.status !== "distributing" && mixtape.status !== "published") {
        throw new ApiError(
          "mixtape_not_distributing",
          "Mint the mixtape (publish) before distributing its video",
          409,
        );
      }

      if (!mixtape.logId) {
        throw new ApiError("mixtape_no_log_id", "Mixtape has no committed Log ID", 409);
      }

      const accessToken = await getYouTubeAccessToken();
      // YouTube caps the title at 100 chars; the description carries the dream
      // note + the fluncle://<logId> breadcrumb + the cued chapter block.
      const title = mixtape.title.slice(0, 100);
      const description = youtubeDescription(mixtape.note ?? "", mixtape.logId, mixtape.members);

      const initiate = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        {
          body: JSON.stringify({
            snippet: {
              categoryId: "10", // Music
              description,
              title,
            },
            status: {
              privacyStatus: "unlisted",
              selfDeclaredMadeForKids: false,
            },
          }),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(contentLength),
            "X-Upload-Content-Type": contentType,
          },
          method: "POST",
        },
      );

      if (!initiate.ok) {
        const detail = (await initiate.text().catch(() => "")).slice(0, 500);
        throw new ApiError(
          "youtube_initiate_failed",
          `YouTube rejected the upload session (${initiate.status} ${initiate.statusText})${detail ? `: ${detail}` : ""}`,
          502,
        );
      }

      const sessionUri = initiate.headers.get("Location");

      if (!sessionUri) {
        throw new ApiError(
          "youtube_no_session",
          "YouTube did not return a resumable session URI",
          502,
        );
      }

      return Response.json({ accessToken, ok: true, sessionUri });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/youtube/initiate")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
