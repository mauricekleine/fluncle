import { createFileRoute } from "@tanstack/react-router";
import {
  enforceRateLimit,
  getGalaxyProgress,
  mergeGalaxyProgress,
} from "../../../lib/server/account-data";
import { requireJsonMutation, requirePublicUser } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/me/galaxy-progress")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await requirePublicUser(request);

        return user instanceof Response ? user : Response.json(await getGalaxyProgress(user));
      },
      PUT: async ({ request }) => {
        const user = await requirePublicUser(request);

        if (user instanceof Response) {
          return user;
        }

        const guard = requireJsonMutation(request, user);

        if (guard) {
          return guard;
        }

        const limited = await enforceRateLimit({
          action: "account.galaxy.merge",
          limit: 30,
          request,
          userId: user.id,
          windowMs: 60 * 60 * 1000,
        });

        if (limited) {
          return limited;
        }

        const result = await mergeGalaxyProgress(user, await request.json());

        return result instanceof Response ? result : Response.json(result);
      },
    },
  },
});
