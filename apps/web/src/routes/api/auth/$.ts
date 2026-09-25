import { createFileRoute } from "@tanstack/react-router";
import { authRateLimit } from "../../../lib/server/auth-rate-limit";
import { getPublicAuth } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => (await getPublicAuth()).handler(request),
      POST: async ({ request }) => {
        const limited = await authRateLimit(request);

        return limited ?? (await getPublicAuth()).handler(request);
      },
    },
  },
});
