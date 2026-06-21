import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../../../-alias";
import { jsonError, requireOperator } from "../../../../../lib/server/env";
import { apiErrorResponse, parseJsonBody } from "../../../../../lib/server/http-errors";
import { lastfmGetSession } from "../../../../../lib/server/lastfm";

// Step 3 of the Last.fm desktop auth flow: trade the now-approved token (from
// /start, after Maurice clicked "Yes, allow access") for a durable session key via
// auth.getSession. The session key does not expire — it's returned to the CLI so
// Maurice can set it as the LASTFM_SESSION_KEY Worker secret. We deliberately do
// NOT persist it server-side (no schema change this wave); the secret is the home.
export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    const parsed = await parseJsonBody(request);

    if (parsed instanceof Response) {
      return parsed;
    }

    const token = (parsed.json as { token?: unknown }).token;

    if (typeof token !== "string" || !token.trim()) {
      return jsonError(400, "invalid_request", "Missing token");
    }

    try {
      const { name, sessionKey } = await lastfmGetSession(token);

      return Response.json({ name, ok: true, sessionKey });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/lastfm/auth/session")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
