import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { deleteAccount, requireAccountMutation } from "../../../lib/server/account-data";

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const user = await requireAccountMutation(request, {
      action: "account.delete",
      limit: 2,
      windowMs: 24 * 60 * 60 * 1000,
    });

    if (user instanceof Response) {
      return user;
    }

    return Response.json(await deleteAccount(user));
  },
};

export const Route = createFileRoute("/api/me/delete")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
