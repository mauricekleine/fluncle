// Shared test-kit for the oRPC handler suites (orpc*.test.ts). These suites all
// drive the SAME thing — `handleOrpc(Request)` against `/api/v1/...` — so they
// were each re-declaring the same request builders, admin-token constants, env
// setup, and public fixtures. This is the one canonical source for those pieces.
//
// NOT a test file: the vitest `include` glob is `src/**/*.test.{ts,tsx}`, so this
// `*-kit.ts` module is imported by suites but never collected as a suite itself.
//
// `readJson` lives here too (re-exported from orpc-test-helpers) so the suites
// have a single import for everything test-shaped.
export { readJson } from "./orpc-test-helpers";

// The canonical API origin every suite hits. Handlers key auth/CSRF/rate-limit on
// this host, so the builders below all anchor to it.
export const BASE = "https://www.fluncle.com/api/v1";

// The two admin principals the live auth spine resolves: the operator token maps
// to `operator`, the agent token to `agent`. Suites set these into the env via
// `setAdminTokenEnv()` in `beforeAll` so the REAL `../orpc-auth` middleware runs.
export const OPERATOR_TOKEN = "test-token-admin-operator";
export const AGENT_TOKEN = "test-token-admin-agent";

// Point the auth spine at the kit's test principals. Call once in `beforeAll`.
export function setAdminTokenEnv(): void {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
}

// Prefix a `/...` path with the API base. `apiUrl("/tracks")` →
// `https://www.fluncle.com/api/v1/tracks`.
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

// The canonical admin-suite request builder: a path under `/api/v1`, a method, an
// optional bearer token, and an optional JSON body (Content-Type is only set when
// a body is present, matching the CLI's `adminApiPost` shape for query-only ops).
export function req(
  path: string,
  method: string,
  token: string | undefined,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return new Request(apiUrl(path), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
}

// A bare GET against a full URL (the public-read suites pass complete URLs with
// query strings, so this takes the URL as-is rather than a path).
export function get(url: string): Request {
  return new Request(url, { method: "GET" });
}

// A POST with a JSON `Content-Type` and a pre-serialized string body.
export function post(url: string, body: string): Request {
  return new Request(url, {
    body,
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

// A POST that serializes an object body.
export function postJson(url: string, payload: unknown): Request {
  return post(url, JSON.stringify(payload));
}

// A JSON request on an arbitrary method (wave-b's `/me` writes use PUT/PATCH/POST).
export function jsonRequest(url: string, method: string, payload: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    method,
  });
}

// A schema-complete public `Track` row. oRPC validates the response body against
// the contract, so handlers that echo a fetched track need the full shape.
export const TRACK = {
  addedAt: "2026-01-01T00:00:00.000Z",
  addedToSpotify: true,
  artists: ["Some Artist"],
  durationMs: 300000,
  enrichmentStatus: "done",
  postedToTelegram: true,
  spotifyUrl: "https://open.spotify.com/track/abc",
  title: "Some Banger",
  trackId: "abc",
};

// A schema-complete public `Mixtape` (published) row for the list envelope.
export const MIXTAPE = {
  artists: ["Fluncle"] as ["Fluncle"],
  externalUrls: {},
  memberCount: 0,
  members: [],
  status: "published" as const,
  title: "A Set",
  type: "mixtape" as const,
};
