import { constantTimeEqual, readCookie, signOauthState } from "./env";

const STATE_COOKIE_MAX_AGE_S = 10 * 60;

export function stateCookieName(purpose: string): string {
  return `fluncle_oauth_${purpose.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
}

function cookieAttributes(maxAgeSeconds: number): string[] {
  return [
    "HttpOnly",

    "SameSite=Lax",

    "Path=/api",
    `Max-Age=${maxAgeSeconds}`,
    ...(import.meta.env.DEV ? [] : ["Secure"]),
  ];
}

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

export function clearedStateCookie(purpose: string): string {
  return [`${stateCookieName(purpose)}=`, ...cookieAttributes(0)].join("; ");
}

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
