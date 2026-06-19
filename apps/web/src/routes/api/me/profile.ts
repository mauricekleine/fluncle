import { createFileRoute } from "@tanstack/react-router";
import { requireAccountMutation, updatePrivateUsername } from "../../../lib/server/account-data";
import { parseJsonBody } from "../../../lib/server/http-errors";

export const Route = createFileRoute("/api/me/profile")({
  server: {
    handlers: {
      PATCH: async ({ request }) => {
        const user = await requireAccountMutation(request, {
          action: "account.profile",
          limit: 10,
        });

        if (user instanceof Response) {
          return user;
        }

        const parsed = await parseJsonBody(request);

        if (parsed instanceof Response) {
          return parsed;
        }

        const result = await updatePrivateUsername(user, parsed.json);

        return result instanceof Response ? result : Response.json(result);
      },
    },
  },
});
