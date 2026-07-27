// OAuth state, bound to the browser that started the flow. ALWAYS.
//
// THE HOLE THIS CLOSES. Every one of Fluncle's seven OAuth legs (the admin Spotify
// login, plus the six platform connects: spotify-auth, youtube, mixcloud, tiktok,
// twitch, instagram) signs a state of `{ iat, nonce, purpose }` and the callback
// verifies the signature + the 10-minute window. But the nonce was never persisted
// anywhere, so it proved nothing: any party holding a still-fresh state value could
// present it at the callback with THEIR authorization code and have Fluncle store
// THEIR platform tokens under Fluncle's own account row. The signature stopped
// forgery; nothing stopped replay.
//
// THE FIX. The start leg also hands the browser a short-lived HttpOnly cookie
// carrying the same nonce, and the callback refuses to exchange the code unless the
// cookie matches the nonce inside the signed state. A state lifted from a log, a
// terminal, or browser history is then useless in any OTHER browser — the two halves
// have to arrive together. The cookie is cleared on the way out, so a state is
// single-use even inside the browser that minted it.
//
// SameSite=Lax is load-bearing and correct here: the callback is a top-level GET
// navigation FROM the platform back to Fluncle, which Lax allows (Strict would drop
// the cookie and break every flow), while a cross-site sub-resource request cannot
// read it.
//
// THE CLI CARVE-OUT IS GONE. `fluncle admin auth <platform>` used to call the start
// route with a Bearer token and print the PROVIDER's authorize URL — a different
// client from the one that received the response, so there was no cookie to bind to.
// That case signed `bind: "none"` and kept only the signature + window, leaving a
// CLI-minted state replayable for ten minutes. It no longer exists: a Bearer-carried
// start now prints a FLUNCLE-ORIGIN handoff link (./oauth-handoff.ts) that mints the
// state inside the operator's logged-in browser, so this module has exactly one
// path. `bind` therefore has one legal value, and the callback gate REJECTS anything
// else — a state with a missing, unknown, or tampered `bind` is refused rather than
// waved through as "probably a CLI start".

import { constantTimeEqual, readCookie, signOauthState } from "./env";

/** How long the browser holds the nonce — the OAuth state window, matched. */
const STATE_COOKIE_MAX_AGE_S = 10 * 60;

/**
 * The per-purpose cookie name. One cookie PER FLOW, not one shared cookie: the
 * operator can have a YouTube connect and a Mixcloud connect open at once, and a
 * single shared name would silently make the first callback fail.
 */
export function stateCookieName(purpose: string): string {
  return `fluncle_oauth_${purpose.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
}

function cookieAttributes(maxAgeSeconds: number): string[] {
  return [
    "HttpOnly",
    // Lax, not Strict: the callback is a top-level cross-site GET navigation back
    // from the platform, and Strict would drop the cookie there.
    "SameSite=Lax",
    // Every start and callback route lives under /api, so the cookie never travels
    // with a public page request.
    "Path=/api",
    `Max-Age=${maxAgeSeconds}`,
    ...(import.meta.env.DEV ? [] : ["Secure"]),
  ];
}

/**
 * Mint a signed OAuth state plus the `Set-Cookie` that pins it to this browser.
 *
 * There is no unbound variant and no `bindToBrowser` switch: every caller is a
 * browser now (a Bearer-carried start is answered with a handoff link instead of a
 * provider URL — ./oauth-handoff.ts), so `setCookie` is unconditional and the
 * callback can demand it unconditionally.
 *
 * `claims` is merged UNDER the fixed fields, never over them: the admin-login leg
 * carries the handoff ticket it must return to after sign-in, and no caller can
 * shadow `bind`, `iat`, `nonce`, or `purpose` by naming one of them.
 */
export async function mintOauthState(
  purpose: string,
  claims: Record<string, string> = {},
): Promise<{ setCookie: string; state: string }> {
  const nonce = crypto.randomUUID();
  const state = await signOauthState({
    ...claims,
    bind: "cookie",
    iat: Date.now(),
    nonce,
    purpose,
  });

  return {
    setCookie: [
      `${stateCookieName(purpose)}=${nonce}`,
      ...cookieAttributes(STATE_COOKIE_MAX_AGE_S),
    ].join("; "),
    state,
  };
}

/** The `Set-Cookie` that consumes the nonce, so a state cannot be replayed twice. */
export function clearedStateCookie(purpose: string): string {
  return [`${stateCookieName(purpose)}=`, ...cookieAttributes(0)].join("; ");
}

/**
 * Whether a verified state payload is allowed to proceed to the token exchange.
 *
 * REJECT-UNKNOWN. Only `bind: "cookie"` with the matching nonce cookie passes.
 * Anything else — a missing `bind`, the retired `"none"`, a tampered value — is
 * refused. The signature already proved Fluncle minted the state, so this is not
 * about forgery; it is that a state Fluncle can no longer explain the binding of is
 * a state Fluncle should not spend an authorization code on. The one cost is that a
 * flow already mid-consent when this deploys fails at the callback; those states
 * live ten minutes, and the operator just runs the connect again.
 */
export function stateIsBoundToThisBrowser(
  request: Request,
  payload: Record<string, unknown>,
): boolean {
  if (payload.bind !== "cookie") {
    return false;
  }

  const purpose = typeof payload.purpose === "string" ? payload.purpose : "";
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  const presented = readCookie(request.headers.get("cookie"), stateCookieName(purpose));

  if (!purpose || !nonce || !presented) {
    return false;
  }

  return constantTimeEqual(presented, nonce);
}
