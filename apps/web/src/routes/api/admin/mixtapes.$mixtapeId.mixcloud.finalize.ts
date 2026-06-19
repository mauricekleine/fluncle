import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { finalizeMixtapeDistribution } from "../../../lib/server/mixtape-social";
import { ApiError } from "../../../lib/server/spotify";

// The CLI uploads the audio master to Mixcloud directly (the Worker can't proxy
// multi-GB media), then POSTs the resolved cloudcast URL here. The Worker records
// the published post, dual-writes `mixtapes.mixcloud_url`, and flips the mixtape
// `distributing → published` on its first live link.
export const Route = createFileRoute("/api/admin/mixtapes/$mixtapeId/mixcloud/finalize")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const body = (await request.json()) as { externalId?: string; url?: string };

          if (typeof body.url !== "string" || body.url.length === 0) {
            throw new ApiError("invalid_request", "Mixcloud finalize requires a url", 400);
          }

          const mixtape = await finalizeMixtapeDistribution(params.mixtapeId, "mixcloud", {
            externalId: body.externalId,
            url: body.url,
          });

          return Response.json({ mixtape, ok: true, platform: "mixcloud" });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});
