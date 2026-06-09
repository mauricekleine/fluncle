import { createFileRoute } from "@tanstack/react-router";

import { jsonError, requireAdmin } from "../../../lib/server/env";
import { type SocialStatusUpdate, updateSocialStatus } from "../../../lib/server/social";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";

type PatchBody = { scheduledFor?: unknown; status?: unknown; url?: unknown };

// PATCH /api/admin/tracks/:idOrLogId/social/:platform
// The manual-review feedback: after the operator reviews the draft in-app and
// schedules/publishes it, update the per-platform status (+ the public URL).
export const Route = createFileRoute("/api/admin/tracks/$trackId/social/$platform")({
  server: {
    handlers: {
      PATCH: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        // .../tracks/<idOrLogId>/social/<platform>
        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        const idOrLogId = parts[parts.length - 3] ?? "";
        const platform = parts[parts.length - 1] ?? "";

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
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
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
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
