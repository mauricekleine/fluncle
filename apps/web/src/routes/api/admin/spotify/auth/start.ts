import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { requireOperator } from "../../../../../lib/server/env";
import { startOauthConnect } from "../../../../../lib/server/oauth-handoff";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    return startOauthConnect(request, "spotify-auth");
  },
};

export const Route = createFileRoute("/api/admin/spotify/auth/start")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
