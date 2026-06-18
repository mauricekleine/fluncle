import { createFileRoute } from "@tanstack/react-router";
import { collectLogId, enforceRateLimit } from "../../../../lib/server/account-data";
import { requireJsonMutation, requirePublicUser } from "../../../../lib/server/public-auth";
import { jsonError } from "../../../../lib/server/env";

export const Route = createFileRoute("/api/me/galaxy-progress/logs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await requirePublicUser(request);

        if (user instanceof Response) {
          return user;
        }

        const guard = requireJsonMutation(request, user);

        if (guard) {
          return guard;
        }

        const limited = await enforceRateLimit({
          action: "account.galaxy.log",
          limit: 120,
          request,
          userId: user.id,
          windowMs: 60 * 60 * 1000,
        });

        if (limited) {
          return limited;
        }

        const body = (await request.json()) as { logId?: unknown };

        if (typeof body.logId !== "string") {
          return jsonError(400, "invalid_request", "Missing Log ID");
        }

        const result = await collectLogId(user, body.logId);

        return result instanceof Response ? result : Response.json(result);
      },
    },
  },
});
