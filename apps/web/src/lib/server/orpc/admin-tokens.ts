// The `admin-tokens` domain router module — the just-in-time credential reads
// for CLI-direct uploads + the Last.fm desktop-auth JSON exchange. Each handler
// reuses the live route logic verbatim; the auth tier moves to the oRPC procedure
// middleware (../orpc-auth). ALL four are operator tier (live `requireOperator`):
// `adminAuth` + `operatorGuard`.

import { ORPCError } from "@orpc/server";
import { lastfmGetSession, lastfmGetToken } from "../lastfm";
import { getMixcloudAccessToken } from "../mixcloud";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { getYouTubeAccessToken } from "../youtube";
import { apiFault, type Implementer } from "./_shared";

function toFault(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    return error;
  }

  return apiFault(error);
}

/**
 * Build the `admin-tokens` domain's handlers. Each reuses the live route logic
 * verbatim; only the auth gate is relocated to the procedure middleware.
 */
export function adminTokensHandlers(os: Implementer) {
  // POST /admin/youtube/token — operator tier (live `requireOperator`).
  const mintYoutubeTokenHandler = os.mint_youtube_token
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        const accessToken = await getYouTubeAccessToken();

        return { accessToken, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/mixcloud/token — operator tier (live `requireOperator`).
  const mintMixcloudTokenHandler = os.mint_mixcloud_token
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        const accessToken = await getMixcloudAccessToken();

        return { accessToken, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // GET /admin/lastfm/auth/start — operator tier (live `requireOperator`).
  const startLastfmAuthHandler = os.start_lastfm_auth
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        const { authUrl, token } = await lastfmGetToken();

        return { authUrl, ok: true as const, token };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/lastfm/auth/session — operator tier (live `requireOperator`). The
  // live route validates `token` itself (`invalid_request`/400 on missing/blank).
  const exchangeLastfmSessionHandler = os.exchange_lastfm_session
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const token = (input as { token?: unknown }).token;

        if (typeof token !== "string" || !token.trim()) {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "invalid_request", apiMessage: "Missing token" },
            message: "Missing token",
            status: 400,
          });
        }

        const { name, sessionKey } = await lastfmGetSession(token);

        return { name, ok: true as const, sessionKey };
      } catch (error) {
        throw toFault(error);
      }
    });

  return {
    exchange_lastfm_session: exchangeLastfmSessionHandler,
    mint_mixcloud_token: mintMixcloudTokenHandler,
    mint_youtube_token: mintYoutubeTokenHandler,
    start_lastfm_auth: startLastfmAuthHandler,
  };
}
