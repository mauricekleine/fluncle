import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { deleteSavedFinding, requireAccountMutation } from "../../../lib/server/account-data";

export const serverHandlers: ApiHandlers = {
  DELETE: async ({ params, request }) => {
    const user = await requireAccountMutation(request, {
      action: "account.saved.delete",
      limit: 90,
    });

    if (user instanceof Response) {
      return user;
    }

    const result = await deleteSavedFinding(user, params.trackId);

    return result instanceof Response ? result : Response.json(result);
  },
};

export const Route = createFileRoute("/api/me/saved-findings/$trackId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
