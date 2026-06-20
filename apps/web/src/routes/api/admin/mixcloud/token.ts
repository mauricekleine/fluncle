import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin } from "../../../../lib/server/env";
import { apiErrorResponse } from "../../../../lib/server/http-errors";
import { getMixcloudAccessToken } from "../../../../lib/server/mixcloud";

// The CLI fetches the Mixcloud access token here just-in-time for its CLI-direct
// upload (the bytes can't go through the Worker, but the credential lives server-
// side — mirroring the YouTube token route). The durable token stays in
// mixcloud_auth; the CLI holds it only transiently for the one upload.
export const Route = createFileRoute("/api/admin/mixcloud/token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const accessToken = await getMixcloudAccessToken();

          return Response.json({ accessToken, ok: true });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});
