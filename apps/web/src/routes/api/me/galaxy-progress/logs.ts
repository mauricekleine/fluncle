import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../-alias";
import { collectLogId, requireAccountMutation } from "../../../../lib/server/account-data";
import { jsonError } from "../../../../lib/server/env";
import { parseJsonBody } from "../../../../lib/server/http-errors";

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const user = await requireAccountMutation(request, {
      action: "account.galaxy.log",
      limit: 120,
    });

    if (user instanceof Response) {
      return user;
    }

    const parsed = await parseJsonBody(request);

    if (parsed instanceof Response) {
      return parsed;
    }

    const body = parsed.json as { logId?: unknown };

    if (typeof body.logId !== "string") {
      return jsonError(400, "invalid_request", "Missing Log ID");
    }

    const result = await collectLogId(user, body.logId);

    return result instanceof Response ? result : Response.json(result);
  },
};

export const Route = createFileRoute("/api/me/galaxy-progress/logs")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
