import { createFileRoute } from "@tanstack/react-router";
import { enforceRateLimit, updatePrivateUsername } from "../../../lib/server/account-data";
import { requireJsonMutation, requirePublicUser } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/me/profile")({
  server: {
    handlers: {
      PATCH: async ({ request }) => {
        const user = await requirePublicUser(request);

        if (user instanceof Response) {
          return user;
        }

        const guard = requireJsonMutation(request, user);

        if (guard) {
          return guard;
        }

        const limited = await enforceRateLimit({
          action: "account.profile",
          limit: 10,
          request,
          userId: user.id,
          windowMs: 60 * 60 * 1000,
        });

        if (limited) {
          return limited;
        }

        const result = await updatePrivateUsername(user, await request.json());

        return result instanceof Response ? result : Response.json(result);
      },
    },
  },
});
