import { createFileRoute } from "@tanstack/react-router";
import { enforceRateLimit } from "../../../lib/server/account-data";
import { getPublicAuth } from "../../../lib/server/public-auth";

async function authRateLimit(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;

  if (path.endsWith("/sign-up/email")) {
    return enforceRateLimit({
      action: "auth.signup",
      limit: 5,
      request,
      windowMs: 60 * 60 * 1000,
    });
  }

  if (path.endsWith("/sign-in/email") || path.endsWith("/sign-in/username")) {
    return enforceRateLimit({
      action: "auth.signin",
      limit: 20,
      request,
      windowMs: 60 * 60 * 1000,
    });
  }

  return undefined;
}

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
