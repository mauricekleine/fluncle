// OAuth state, bound to the browser that started the flow.
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
// THE FIX. The start leg now also hands the browser a short-lived HttpOnly cookie
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
// THE CLI CARVE-OUT, stated plainly. `fluncle admin auth <platform>` calls the start
// route with a Bearer token, prints the authorize URL, and the operator opens it in a
// browser — a DIFFERENT client from the one that received the response, so there is
// no cookie to bind to. The bind requirement is therefore recorded IN THE SIGNED
// STATE (`bind: "cookie" | "none"`), which an attacker cannot flip. A browser-started
// flow is always bound; a CLI-started flow keeps exactly today's behaviour (signature
// + 10-minute window). The residual is a CLI-minted state replayable for 10 minutes,
// unchanged from before this module — closing it needs a Fluncle-origin handoff URL
// for the CLI path (a follow-up, not a regression).

import { constantTimeEqual, readCookie, signOauthState } from "./env";

/** How long the browser holds the nonce — the OAuth state window, matched. */
const STATE_COOKIE_MAX_AGE_S = 10 * 60;

/** Whether the state must be matched against a browser cookie at the callback. */
export type StateBinding = "cookie" | "none";

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
 * Mint a signed OAuth state plus, when the caller is a browser, the `Set-Cookie`
 * that pins it to that browser.
 *
 * `bindToBrowser` is decided by the CARRIER, never by a client-supplied hint: the
 * start routes pass `!hasBearerHeader(request)`, so a cookie-carried (browser) start
 * binds and a Bearer-carried (CLI/agent) start does not.
 */
export async function mintOauthState(
  purpose: string,
  options: { bindToBrowser: boolean },
): Promise<{ setCookie?: string; state: string }> {
  const nonce = crypto.randomUUID();
  const bind: StateBinding = options.bindToBrowser ? "cookie" : "none";
  const state = await signOauthState({ bind, iat: Date.now(), nonce, purpose });

  if (!options.bindToBrowser) {
    return { state };
  }

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
 * - `bind: "cookie"` (a browser-started flow) → the request MUST carry the matching
 *   nonce cookie. A missing, empty, or different cookie is refused.
 * - `bind: "none"` (a CLI-started flow) → no cookie exists to check; the signature
 *   and the 10-minute window are the whole gate, exactly as before.
 * - anything else (a state minted before this shipped, or a tampered `bind`) → the
 *   signature already proved Fluncle minted it, so treat an unknown binding as
 *   unbound rather than breaking a flow mid-consent. Those states expire in ten
 *   minutes regardless, and the key rotation on this deploy already invalidated them.
 */
export function stateIsBoundToThisBrowser(
  request: Request,
  payload: Record<string, unknown>,
): boolean {
  if (payload.bind !== "cookie") {
    return true;
  }

  const purpose = typeof payload.purpose === "string" ? payload.purpose : "";
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  const presented = readCookie(request.headers.get("cookie"), stateCookieName(purpose));

  if (!purpose || !nonce || !presented) {
    return false;
  }

  return constantTimeEqual(presented, nonce);
}
