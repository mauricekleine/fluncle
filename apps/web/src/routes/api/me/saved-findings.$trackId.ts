import { createFileRoute } from "@tanstack/react-router";
import { deleteSavedFinding, enforceRateLimit } from "../../../lib/server/account-data";
import { requireJsonMutation, requirePublicUser } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/me/saved-findings/$trackId")({
  server: {
    handlers: {
      DELETE: async ({ params, request }) => {
        const user = await requirePublicUser(request);

        if (user instanceof Response) {
          return user;
        }

        const guard = requireJsonMutation(request, user);

        if (guard) {
          return guard;
        }

        const limited = await enforceRateLimit({
          action: "account.saved.delete",
          limit: 90,
          request,
          userId: user.id,
          windowMs: 60 * 60 * 1000,
        });

        if (limited) {
          return limited;
        }

        const result = await deleteSavedFinding(user, params.trackId);

        return result instanceof Response ? result : Response.json(result);
      },
    },
  },
});
