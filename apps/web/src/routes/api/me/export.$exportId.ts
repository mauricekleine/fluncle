import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { getAccountExport } from "../../../lib/server/account-data";
import { requireParam } from "../../../lib/server/http-errors";
import { requirePublicUser } from "../../../lib/server/public-auth";

export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const user = await requirePublicUser(request);

    if (user instanceof Response) {
      return user;
    }

    const result = await getAccountExport(user, requireParam(params.exportId, "exportId"));

    return result instanceof Response ? result : Response.json(result);
  },
};

export const Route = createFileRoute("/api/me/export/$exportId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
