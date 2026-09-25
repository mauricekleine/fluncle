import { oc } from "@orpc/contract";
import * as z from "zod";

export const mintYoutubeToken = oc
  .route({
    method: "POST",
    operationId: "mintYoutubeToken",
    path: "/admin/youtube/token",
    summary: "Mint a fresh short-lived YouTube access token",
    tags: ["Admin"],
  })
  .output(z.object({ accessToken: z.string(), ok: z.literal(true) }));

export const mintMixcloudToken = oc
  .route({
    method: "POST",
    operationId: "mintMixcloudToken",
    path: "/admin/mixcloud/token",
    summary: "Mint a Mixcloud access token for a CLI-direct upload",
    tags: ["Admin"],
  })
  .output(z.object({ accessToken: z.string(), ok: z.literal(true) }));

export const startLastfmAuth = oc
  .route({
    method: "GET",
    operationId: "startLastfmAuth",
    path: "/admin/lastfm/auth/start",
    summary: "Start the Last.fm desktop auth flow (request token + authorize URL)",
    tags: ["Admin"],
  })
  .output(z.object({ authUrl: z.string(), ok: z.literal(true), token: z.string() }));

export const exchangeLastfmSession = oc
  .route({
    method: "POST",
    operationId: "exchangeLastfmSession",
    path: "/admin/lastfm/auth/session",
    summary: "Exchange the approved Last.fm token for a durable session key",
    tags: ["Admin"],
  })
  .input(z.looseObject({ token: z.unknown().optional() }))
  .output(z.object({ name: z.string(), ok: z.literal(true), sessionKey: z.string() }));

export const revokeAdminGrants = oc
  .route({
    method: "POST",
    operationId: "revokeAdminGrants",
    path: "/admin/auth/revoke-grants",
    summary: "Revoke every admin browser session (bump the grant epoch)",
    tags: ["Admin"],
  })
  .output(z.object({ epoch: z.number().int().nonnegative(), ok: z.literal(true) }));

export const adminTokensContract = {
  exchange_lastfm_session: exchangeLastfmSession,
  mint_mixcloud_token: mintMixcloudToken,
  mint_youtube_token: mintYoutubeToken,
  revoke_admin_grants: revokeAdminGrants,
  start_lastfm_auth: startLastfmAuth,
};
