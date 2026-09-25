import { API_BASE } from "@/config";

export const ME_ORIGIN = new URL(API_BASE).origin;

export const CSRF_ENDPOINT = "/api/v1/me/csrf";
export const CSRF_HEADER = "x-fluncle-csrf";

const MUTATION_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export function isMutation(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

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

type MeRequestInit = {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
};

export type MeFetchDeps = {
  baseUrl?: string;
  fetchImpl: typeof fetch;
  getCookie: () => string | null | undefined;
};

export type MeFetch = (path: string, init?: MeRequestInit) => Promise<Response>;

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
