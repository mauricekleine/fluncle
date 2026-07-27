// The CLI → browser OAuth handoff: how a connect started in a terminal still ends
// browser-bound.
//
// THE RESIDUAL THIS CLOSES. ./oauth-state.ts pins an OAuth state to the browser that
// started the flow with a one-shot nonce cookie. That works for a browser start and
// could not work for `fluncle admin auth <platform>`: the CLI held the Bearer token,
// the start route answered the CLI, and the operator pasted the provider's authorize
// URL into a browser that had never been handed a cookie. Those states were signed
// `bind: "none"` — replayable by anyone who saw them, for ten minutes.
//
// THE HANDOFF. A Bearer-carried start no longer returns the provider's URL at all.
// It returns a FLUNCLE-ORIGIN link carrying a short-lived HMAC TICKET (its own
// labeled subkey, `fluncle/oauth-handoff/v1` — a ticket can never verify as a state
// or as a grant cookie). The operator opens that link in their browser; the handoff
// route demands the ADMIN GRANT COOKIE, then does exactly what a browser start does
// — mint a `bind: "cookie"` state, set the nonce cookie, 302 to the provider. The
// state is minted in the same browser that will come back with it, so the CLI path
// and the browser path are now the same path with a different front door.
//
// WHAT A LEAKED TICKET BUYS. Nothing on its own: without the admin grant cookie the
// route mints no state, sets no cookie, and redirects to /admin/login. It is not a
// credential, it is a NAME for a flow — which is why it carries only a purpose and
// an issue time, never a token, a scope, or a redirect target.
//
// The purpose registry below is the allow-list: a ticket for anything not in it is
// refused. `admin-login` is deliberately absent — logging in is what MINTS the grant
// cookie the handoff requires, so a login handoff could only ever be a loop.

import { hasBearerHeader, signOauthHandoff, verifyOauthHandoff } from "./env";
import { apiErrorResponse } from "./http-errors";
import { buildInstagramAuthUrl, instagramRedirectUri } from "./instagram";
import { buildMixcloudAuthUrl, mixcloudRedirectUri } from "./mixcloud";
import { mintOauthState } from "./oauth-state";
import { buildSpotifyAuthUrl } from "./spotify";
import { buildTikTokAuthUrl } from "./tiktok";
import { buildTwitchAuthUrl, twitchRedirectUri } from "./twitch";
import { buildYouTubeAuthUrl } from "./youtube";

/** Where the handoff link points. Canonical `/api/v1`, like every other CLI call. */
export const OAUTH_HANDOFF_PATH = "/api/v1/admin/oauth/handoff";

/**
 * The six platform connects, each mapped to the provider authorize URL it builds.
 * ONE registry, read by both front doors — the browser start route and the handoff
 * route — so the two can never drift into building different URLs for the same flow.
 *
 * Two of the six derive their redirect URI from the request origin rather than an
 * env var (Mixcloud, Twitch, Instagram), which is why `origin` is a parameter here
 * instead of something each builder reads for itself.
 */
const HANDOFF_FLOWS = {
  "instagram-auth": (state: string, origin: string) =>
    buildInstagramAuthUrl(state, instagramRedirectUri(origin)),
  "mixcloud-auth": (state: string, origin: string) =>
    buildMixcloudAuthUrl(state, mixcloudRedirectUri(origin)),
  "spotify-auth": (state: string) => buildSpotifyAuthUrl(state),
  "tiktok-auth": (state: string) => buildTikTokAuthUrl(state),
  "twitch-auth": (state: string, origin: string) =>
    buildTwitchAuthUrl(state, twitchRedirectUri(origin)),
  "youtube-auth": (state: string) => buildYouTubeAuthUrl(state),
} satisfies Record<string, (state: string, origin: string) => Promise<string>>;

/** A connect flow the handoff is allowed to carry (`admin-login` is not one). */
export type OauthConnectPurpose = keyof typeof HANDOFF_FLOWS;

function isConnectPurpose(value: unknown): value is OauthConnectPurpose {
  return typeof value === "string" && Object.hasOwn(HANDOFF_FLOWS, value);
}

/** Mint the ticket. Claims are the whole story: which flow, and when it was issued. */
export async function mintHandoffTicket(purpose: OauthConnectPurpose): Promise<string> {
  return signOauthHandoff({ iat: Date.now(), purpose });
}

/**
 * The purpose a ticket names, or `undefined` for any ticket that must not be acted
 * on: a bad signature, one past its ten-minute window, or one naming a purpose
 * outside the registry (including the deliberately-excluded `admin-login`). One
 * return value for every rejection, because the route's answer is the same either
 * way and a caller should not be able to tell the three apart.
 */
export async function readHandoffTicket(
  token: string | null,
): Promise<OauthConnectPurpose | undefined> {
  if (!token) {
    return undefined;
  }

  try {
    const purpose = (await verifyOauthHandoff(token)).purpose;

    return isConnectPurpose(purpose) ? purpose : undefined;
  } catch {
    return undefined;
  }
}

/** The Fluncle-origin link the CLI prints. Absolute, so it is paste-ready. */
export function handoffUrl(origin: string, ticket: string): string {
  return `${origin}${OAUTH_HANDOFF_PATH}?token=${encodeURIComponent(ticket)}`;
}

/**
 * Mint a browser-bound state for `purpose` and the 302 that sends the browser on to
 * the provider with it. The one place a connect actually begins — the browser start
 * route reaches it through `startOauthConnect`, the handoff route calls it directly
 * once it has proved the caller is the logged-in operator.
 */
export async function providerRedirect(
  purpose: OauthConnectPurpose,
  origin: string,
): Promise<Response> {
  const { setCookie, state } = await mintOauthState(purpose);
  const authUrl = await HANDOFF_FLOWS[purpose](state, origin);

  return new Response(null, {
    headers: { Location: authUrl, "Set-Cookie": setCookie },
    status: 302,
  });
}

/**
 * The shared body of all six per-platform `auth/start` routes, branching on the
 * CARRIER (never
 * on a client-supplied hint):
 *
 * - COOKIE (a browser, the /admin board's connect button) → mint the bound state
 *   here and answer with the provider's URL plus its nonce cookie, as before.
 * - BEARER (the CLI or the agent box) → answer with a handoff link instead. The
 *   caller cannot bind a cookie, so it is not given a state to lose control of.
 *
 * Both answers keep the `{ authUrl, ok }` shape the CLI and the board already read;
 * only where the URL points changes.
 */
export async function startOauthConnect(
  request: Request,
  purpose: OauthConnectPurpose,
): Promise<Response> {
  const origin = new URL(request.url).origin;

  try {
    if (hasBearerHeader(request)) {
      // CONFIG PRE-FLIGHT. Every builder is a pure env read + string build, so
      // building one and discarding it costs nothing and keeps the documented
      // behaviour of an unconfigured platform: `fluncle admin auth twitch` against a
      // Worker with no TWITCH_CLIENT_ID still answers a clean "not configured" 400
      // here, rather than printing a link that only fails once it reaches a browser.
      // The state is deliberately empty — this URL is never handed to anyone.
      await HANDOFF_FLOWS[purpose]("", origin);

      return Response.json({
        authUrl: handoffUrl(origin, await mintHandoffTicket(purpose)),
        ok: true,
      });
    }

    const { setCookie, state } = await mintOauthState(purpose);

    return Response.json(
      { authUrl: await HANDOFF_FLOWS[purpose](state, origin), ok: true },
      { headers: { "Set-Cookie": setCookie } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
