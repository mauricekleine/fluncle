import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { requireAccountMutation, updatePrivateUsername } from "../../../lib/server/account-data";
import { parseJsonBody } from "../../../lib/server/http-errors";

export const serverHandlers: ApiHandlers = {
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
};

export const Route = createFileRoute("/api/me/profile")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
