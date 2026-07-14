// The authenticated fetch for the private `/me` tier (RFC: accounts in the pocket).
// Every future account slice (preferences, saved findings, saved sets) mutates through
// this one helper — it is built for them, not just this auth slice.
//
// Native has NO cookie jar: the Better Auth Expo client stores the session cookie in
// SecureStore and hands it back via `authClient.getCookie()`. This helper replays that
// cookie as a `Cookie` header (the server's `getSession` reads it exactly as a browser's),
// and for a mutation it first GETs `/api/me/csrf` (with the cookie) and attaches the
// returned token as `x-fluncle-csrf` — the same two-step the web account page does.
//
// THE ORIGIN HEADER is load-bearing on native. The server's `requireJsonMutation` gate
// (public-auth.ts) rejects any account mutation whose `Origin` is absent or mismatched.
// A browser sets `Origin` itself and forbids JS from touching it; React Native sets none
// and lets JS set it — so this helper stamps `Origin: <API_BASE origin>` to satisfy the
// same-origin gate. No server change is needed; the app truthfully declares which API
// origin it speaks to.
//
// This module is deliberately RN-free (no `expo-secure-store`, no auth-client import) so
// the header assembly is unit-testable in the repo's framework-free harness (see
// me-fetch.test.ts). The real cookie source + `fetch` are injected by auth-client.ts via
// `createMeFetch`, mirroring the saved-store.ts (pure) / saved.ts (wiring) split.

import { API_BASE } from "@/config";

/** The API origin the app speaks to — stamped on every `/me` request (see the Origin note above). */
export const ME_ORIGIN = new URL(API_BASE).origin;

/** The mutation-token endpoint (GET, cookie-authenticated) and the header it feeds. */
export const CSRF_ENDPOINT = "/api/me/csrf";
export const CSRF_HEADER = "x-fluncle-csrf";

const MUTATION_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

/** True ⇔ this HTTP method passes through the server's CSRF + origin mutation gate. */
export function isMutation(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

/**
 * Assemble the headers for one `/me` request. PURE — no I/O, no RN — so it is fully
 * unit-tested. `Origin` is always stamped (harmless on reads, required on writes); the
 * `Cookie` rides whenever a session exists; `Content-Type: application/json` when a JSON
 * body is sent; and `x-fluncle-csrf` only on a mutation that carries a token.
 */
export function buildMeHeaders(options: {
  base?: Record<string, string>;
  cookie?: string | null;
  csrfToken?: string | null;
  json?: boolean;
  method: string;
}): Record<string, string> {
  const headers: Record<string, string> = { ...options.base };
  headers.Origin = ME_ORIGIN;

  const cookie = options.cookie?.trim();
  if (cookie) {
    headers.Cookie = cookie;
  }
  if (options.json) {
    headers["Content-Type"] = "application/json";
  }
  if (isMutation(options.method) && options.csrfToken) {
    headers[CSRF_HEADER] = options.csrfToken;
  }

  return headers;
}

/** The narrow request shape the `/me` tier uses: a method, optional JSON string body, and extra headers. */
export type MeRequestInit = {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
};

/** The injected side-effects: where the session cookie comes from, the `fetch` to use, and the API base. */
export type MeFetchDeps = {
  baseUrl?: string;
  fetchImpl: typeof fetch;
  getCookie: () => string | null | undefined;
};

/** The fetch signature every account slice consumes. */
export type MeFetch = (path: string, init?: MeRequestInit) => Promise<Response>;

// GET /api/me/csrf with the session cookie → the short-lived mutation token, or null if the
// session is gone (a null token means the mutation below will 403, the honest outcome).
async function fetchCsrfToken(
  deps: Required<Pick<MeFetchDeps, "baseUrl" | "fetchImpl">>,
  cookie: string | null | undefined,
): Promise<string | null> {
  const response = await deps.fetchImpl(`${deps.baseUrl}${CSRF_ENDPOINT}`, {
    headers: buildMeHeaders({ cookie, method: "GET" }),
    method: "GET",
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { csrfToken?: string };
  return data.csrfToken ?? null;
}

/**
 * Build the bound `meFetch` from its injected dependencies. Reads (GET) attach the cookie
 * + origin; mutations additionally fetch and attach the CSRF token. Returns the raw
 * `Response` so callers own status handling (the account modal reads `.ok`).
 */
export function createMeFetch(deps: MeFetchDeps): MeFetch {
  const baseUrl = deps.baseUrl ?? API_BASE;

  return async (path, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const cookie = deps.getCookie();
    const csrfToken = isMutation(method)
      ? await fetchCsrfToken({ baseUrl, fetchImpl: deps.fetchImpl }, cookie)
      : null;
    const headers = buildMeHeaders({
      base: init.headers,
      cookie,
      csrfToken,
      json: init.body !== undefined,
      method,
    });

    return deps.fetchImpl(`${baseUrl}${path}`, { body: init.body, headers, method });
  };
}
