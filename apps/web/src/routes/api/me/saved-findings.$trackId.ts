import { createFileRoute } from "@tanstack/react-router";
import { deleteSavedFinding, requireAccountMutation } from "../../../lib/server/account-data";

export const Route = createFileRoute("/api/me/saved-findings/$trackId")({
  server: {
    handlers: {
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
    },
  },
});
