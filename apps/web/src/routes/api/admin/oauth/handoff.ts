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

// The CLI's front door into a browser-bound connect (lib/server/oauth-handoff.ts).
//
// `fluncle admin auth <platform>` prints a link to HERE, not to the provider. The
// operator opens it in the browser they are already logged into, and this route does
// what the /admin board's connect button does: mint a `bind: "cookie"` state, set the
// one-shot nonce cookie, 302 to the provider. The state never exists outside the
// browser that will bring it back.
//
// THE GRANT COOKIE IS THE GATE, and deliberately NOT `requireOperator`: a Bearer
// token is exactly the carrier this route exists to stop accepting, since a Bearer
// caller cannot hold the nonce cookie the state would be pinned to. Only the browser
// grant passes. A ticket opened without it mints nothing and bounces to the login,
// carrying the ticket so the operator lands back here after signing in.
//
// A 302 CARVE-OUT like its `auth/` siblings (AGENTS.md): it emits redirects, never
// RPC JSON, so it will never be an oRPC op.
export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const purpose = await readHandoffTicket(token);

    // One answer for a missing, forged, expired, or out-of-registry ticket — the
    // caller learns only that this link is not usable.
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
      // An unconfigured platform (no client id/secret) answers a clean 400 here, the
      // same as it does on the start route.
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/oauth/handoff")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
