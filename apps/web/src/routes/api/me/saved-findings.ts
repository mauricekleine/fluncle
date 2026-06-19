import { createFileRoute } from "@tanstack/react-router";
import {
  listSavedFindings,
  requireAccountMutation,
  saveFinding,
} from "../../../lib/server/account-data";
import { parseJsonBody } from "../../../lib/server/http-errors";
import { requirePublicUser } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/me/saved-findings")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await requirePublicUser(request);

        return user instanceof Response ? user : Response.json(await listSavedFindings(user));
      },
      POST: async ({ request }) => {
        const user = await requireAccountMutation(request, {
          action: "account.saved.write",
          limit: 90,
        });

        if (user instanceof Response) {
          return user;
        }

        const parsed = await parseJsonBody(request);

        if (parsed instanceof Response) {
          return parsed;
        }

        const result = await saveFinding(user, parsed.json);

        return result instanceof Response ? result : Response.json(result);
      },
    },
  },
});
