// The client half of the account mutation guard. Every write a signed-in visitor
// makes carries a CSRF token the origin minted for their session, so a control
// that mutates the account does the same three-step dance: ask `/api/v1/me/csrf`
// for a token, put it on the `x-fluncle-csrf` header, and send a lapsed session to
// `/account` to sign in again. This module is that dance, once.
//
// Two entry points, because the call sites split cleanly in two:
//   `authedJsonFetch` — one request, one token: the whole dance in a single call.
//   `fetchCsrfToken` + `csrfJsonHeaders` — a token held across SEVERAL requests
//     (the set dialog's PATCH-then-POST fallback), or a caller that must swallow a
//     lapsed session instead of navigating away (the fire-and-forget preference
//     sync).

const CSRF_HEADER = "x-fluncle-csrf";

/** Where a signed-out visitor goes to get a session back. */
const SIGN_IN_PATH = "/account";

function goSignIn(): void {
  window.location.href = SIGN_IN_PATH;
}

/** The JSON mutation headers: the content type plus the session's CSRF token. */
export function csrfJsonHeaders(token: string): Record<string, string> {
  return { "Content-Type": "application/json", [CSRF_HEADER]: token };
}

/**
 * Mint a CSRF token for the current session.
 *
 * A 401 means the session lapsed. By default that navigates to `/account` and
 * resolves `undefined`, so the caller just returns; `onLapsedSession: "ignore"`
 * resolves `undefined` on ANY non-ok response and navigates nowhere, for a
 * background sync that must stay invisible.
 */
export async function fetchCsrfToken(options?: {
  onLapsedSession?: "ignore" | "redirect";
}): Promise<string | undefined> {
  const response = await fetch("/api/v1/me/csrf");

  if (options?.onLapsedSession === "ignore") {
    if (!response.ok) {
      return undefined;
    }
  } else if (response.status === 401) {
    goSignIn();

    return undefined;
  }

  const { csrfToken } = (await response.json()) as { csrfToken?: string };

  return csrfToken ?? "";
}

/**
 * A CSRF-guarded JSON request against the account API: token, header, send.
 *
 * Resolves `undefined` when the session lapsed on either leg — the token mint or
 * the request itself — having already sent the visitor to sign in. A caller that
 * gets `undefined` has nothing left to do; anything else is a real Response to
 * read `ok` and a body off.
 */
export async function authedJsonFetch(
  path: string,
  init: Omit<RequestInit, "headers">,
): Promise<Response | undefined> {
  const token = await fetchCsrfToken();

  if (token === undefined) {
    return undefined;
  }

  const response = await fetch(path, { ...init, headers: csrfJsonHeaders(token) });

  if (response.status === 401) {
    goSignIn();

    return undefined;
  }

  return response;
}
