import { ORPCError } from "@orpc/server";
import { revokeAdminGrants } from "../env";
import { lastfmGetSession, lastfmGetToken } from "../lastfm";
import { getMixcloudAccessToken } from "../mixcloud";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { getYouTubeAccessToken } from "../youtube";
import { apiFault, type Implementer, toFault } from "./_shared";

export function adminTokensHandlers(os: Implementer) {
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

  const exchangeLastfmSessionHandler = os.exchange_lastfm_session
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const token = input.token;

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

  const revokeAdminGrantsHandler = os.revoke_admin_grants
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        return { epoch: await revokeAdminGrants(), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    exchange_lastfm_session: exchangeLastfmSessionHandler,
    mint_mixcloud_token: mintMixcloudTokenHandler,
    mint_youtube_token: mintYoutubeTokenHandler,
    revoke_admin_grants: revokeAdminGrantsHandler,
    start_lastfm_auth: startLastfmAuthHandler,
  };
}
