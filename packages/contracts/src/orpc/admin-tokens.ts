// The `admin-tokens` domain contract module — the just-in-time credential reads
// the CLI needs for its CLI-direct uploads (the bytes can't proxy through the
// Worker, but the credential lives server-side), plus the Last.fm desktop-auth
// JSON exchange. Part of the admin fan-out, built on the same pattern as
// `./admin-tracks.ts`.
//
// ALL four are operator tier (live `requireOperator`). VERIFIED against the live
// handlers. None redirect — they return RPC JSON — so they are convertible (the
// OAuth *redirect* starts/callbacks stay carved out; the Last.fm `auth/*` pair is
// JSON, not a redirect, so it joins the wave).
//
//   - `mint_youtube_token` / `mint_mixcloud_token` — a fresh short-lived access
//     token for the CLI-direct upload.
//   - `start_lastfm_auth` — step 1 of the Last.fm desktop flow (auth.getToken →
//     the request token + the authorize URL Maurice approves).
//   - `exchange_lastfm_session` — step 3: trade the approved token for the durable
//     session key (LOOSE body — the live route validates `token` itself,
//     `invalid_request`).

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * `mint_youtube_token` → `POST /admin/youtube/token` (operationId
 * `mintYoutubeToken`).
 *
 * Operator tier (live `requireOperator`). A fresh short-lived YouTube access
 * token WITHOUT opening a new resumable session. Preserves `{ accessToken, ok }`.
 */
export const mintYoutubeToken = oc
  .route({
    method: "POST",
    operationId: "mintYoutubeToken",
    path: "/admin/youtube/token",
    summary: "Mint a fresh short-lived YouTube access token",
    tags: ["Admin"],
  })
  .output(z.object({ accessToken: z.string(), ok: z.literal(true) }));

/**
 * `mint_mixcloud_token` → `POST /admin/mixcloud/token` (operationId
 * `mintMixcloudToken`).
 *
 * Operator tier (live `requireOperator`). A Mixcloud access token for the
 * CLI-direct upload. Preserves `{ accessToken, ok }`.
 */
export const mintMixcloudToken = oc
  .route({
    method: "POST",
    operationId: "mintMixcloudToken",
    path: "/admin/mixcloud/token",
    summary: "Mint a Mixcloud access token for a CLI-direct upload",
    tags: ["Admin"],
  })
  .output(z.object({ accessToken: z.string(), ok: z.literal(true) }));

/**
 * `start_lastfm_auth` → `GET /admin/lastfm/auth/start` (operationId
 * `startLastfmAuth`).
 *
 * Operator tier (live `requireOperator`). Step 1 of the Last.fm desktop flow:
 * auth.getToken → a request token + the authorize URL. NOT an OAuth redirect (it
 * returns JSON), so it converts. Preserves `{ authUrl, ok, token }`.
 */
export const startLastfmAuth = oc
  .route({
    method: "GET",
    operationId: "startLastfmAuth",
    path: "/admin/lastfm/auth/start",
    summary: "Start the Last.fm desktop auth flow (request token + authorize URL)",
    tags: ["Admin"],
  })
  .output(z.object({ authUrl: z.string(), ok: z.literal(true), token: z.string() }));

/**
 * `exchange_lastfm_session` → `POST /admin/lastfm/auth/session` (operationId
 * `exchangeLastfmSession`).
 *
 * Operator tier (live `requireOperator`). Step 3: trade the approved token for the
 * durable session key. LOOSE body — the live route validates `token` itself
 * (`invalid_request`/400 on a missing/blank token). Preserves `{ name, ok,
 * sessionKey }`.
 */
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

/** The `admin-tokens` domain's ops, merged into the root contract by `./index.ts`. */
export const adminTokensContract = {
  exchange_lastfm_session: exchangeLastfmSession,
  mint_mixcloud_token: mintMixcloudToken,
  mint_youtube_token: mintYoutubeToken,
  start_lastfm_auth: startLastfmAuth,
};
