import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import {
  getGalaxyProgress,
  mergeGalaxyProgress,
  requireAccountMutation,
} from "../../../lib/server/account-data";
import { parseJsonBody } from "../../../lib/server/http-errors";
import { requirePublicUser } from "../../../lib/server/public-auth";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const user = await requirePublicUser(request);

    return user instanceof Response ? user : Response.json(await getGalaxyProgress(user));
  },
  PUT: async ({ request }) => {
    const user = await requireAccountMutation(request, {
      action: "account.galaxy.merge",
      limit: 30,
    });

    if (user instanceof Response) {
      return user;
    }

    const parsed = await parseJsonBody(request);

    if (parsed instanceof Response) {
      return parsed;
    }

    const result = await mergeGalaxyProgress(user, parsed.json);

    return result instanceof Response ? result : Response.json(result);
  },
};

export const Route = createFileRoute("/api/me/galaxy-progress")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
