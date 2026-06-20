import { createFileRoute } from "@tanstack/react-router";

import { jsonError, requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse, trackNotFoundResponse } from "../../../lib/server/http-errors";
import { type SocialStatusUpdate, updateSocialStatus } from "../../../lib/server/social";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

type PatchBody = { scheduledFor?: unknown; status?: unknown; url?: unknown };

// PATCH /api/admin/tracks/:idOrLogId/social/:platform
// The manual-review feedback: after the operator reviews the draft in-app and
// schedules/publishes it, update the per-platform status (+ the public URL).

export const Route = createFileRoute("/api/admin/tracks/$trackId/social/$platform")({
  server: {
    handlers: {
      PATCH: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        const idOrLogId = params.trackId;
        const platform = params.platform;

        try {
          const body = (await request.json()) as PatchBody;
          const status = body.status;

          if (status !== "scheduled" && status !== "published" && status !== "failed") {
            return jsonError(400, "bad_status", "status must be scheduled, published, or failed");
          }

          if (status === "published" && typeof body.url !== "string") {
            return jsonError(400, "url_required", "Publishing requires the post --url");
          }

          const update: SocialStatusUpdate = { status };

          if (typeof body.url === "string") {
            update.url = body.url;
          }

          if (typeof body.scheduledFor === "string") {
            update.scheduledFor = body.scheduledFor;
          }

          const track = await getTrackByIdOrLogId(idOrLogId);

          if (!track) {
            return trackNotFoundResponse(idOrLogId);
          }

          const updated = await updateSocialStatus(track.trackId, platform, update);

          if (!updated) {
            return jsonError(
              404,
              "no_post",
              `No ${platform} post for this track; push a draft first`,
            );
          }

          return Response.json({ ok: true, platform, status, trackId: track.trackId });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});

export const serverHandlers = Route.options.server!.handlers;
