import { createFileRoute } from "@tanstack/react-router";
import { getAccountExport } from "../../../lib/server/account-data";
import { requirePublicUser } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/me/export/$exportId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const user = await requirePublicUser(request);

        if (user instanceof Response) {
          return user;
        }

        const result = await getAccountExport(user, params.exportId);

        return result instanceof Response ? result : Response.json(result);
      },
    },
  },
});
