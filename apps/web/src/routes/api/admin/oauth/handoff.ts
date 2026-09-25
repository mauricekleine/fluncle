import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../-alias";
import {
  ADMIN_COOKIE_NAME,
  jsonError,
  readCookie,
  verifyAdminGrant,
} from "../../../../lib/server/env";
import { apiErrorResponse } from "../../../../lib/server/http-errors";
import { providerRedirect, readHandoffTicket } from "../../../../lib/server/oauth-handoff";

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const purpose = await readHandoffTicket(token);

    if (!purpose || !token) {
      return jsonError(400, "invalid_handoff", "This connect link is expired or invalid");
    }

    if (!(await verifyAdminGrant(readCookie(request.headers.get("cookie"), ADMIN_COOKIE_NAME)))) {
      return new Response(null, {
        headers: { Location: `/admin/login?handoff=${encodeURIComponent(token)}` },
        status: 302,
      });
    }

    try {
      return await providerRedirect(purpose, url.origin);
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/oauth/handoff")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
