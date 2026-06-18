import { createFileRoute } from "@tanstack/react-router";
import { enforceRateLimit, exportAccountData } from "../../../lib/server/account-data";
import { requireJsonMutation, requirePublicUser } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/me/export")({
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
          action: "account.export",
          limit: 3,
          request,
          userId: user.id,
          windowMs: 24 * 60 * 60 * 1000,
        });

        if (limited) {
          return limited;
        }

        return Response.json(await exportAccountData(user));
      },
    },
  },
});
