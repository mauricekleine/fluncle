// Self-running checks for the private-`/me` fetch helper — no framework, mirroring the
// repo's node:assert-free style (saved-store.test.ts / mix-store.test.ts). Run via
// `bun test` or `bun src/lib/me-fetch.test.ts`.
//
// These pin the load-bearing header assembly: the Origin stamp (the same-origin gate on
// native), the cookie replay, the JSON content-type, and — the one that a future
// preferences/saves slice will lean on — that a MUTATION first fetches the CSRF token
// (with the cookie) and attaches it as `x-fluncle-csrf`, while a READ never does.

import {
  buildMeHeaders,
  createMeFetch,
  CSRF_ENDPOINT,
  CSRF_HEADER,
  isMutation,
  ME_ORIGIN,
} from "@/lib/me-fetch";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. isMutation classifies the write methods, case-insensitively; GET/HEAD are reads.
assertEqual(isMutation("post"), true, "POST is a mutation");
assertEqual(isMutation("DELETE"), true, "DELETE is a mutation");
assertEqual(isMutation("Patch"), true, "PATCH is a mutation");
assertEqual(isMutation("GET"), false, "GET is a read");
assertEqual(isMutation("head"), false, "HEAD is a read");

// 2. buildMeHeaders always stamps Origin (the native same-origin gate), even on a bare read.
const read = buildMeHeaders({ method: "GET" });
assertEqual(read.Origin, ME_ORIGIN, "Origin is always stamped");
assertEqual(read.Cookie, undefined, "no cookie → no Cookie header");
assertEqual(read["Content-Type"], undefined, "a read carries no JSON content-type");
assertEqual(read[CSRF_HEADER], undefined, "a read carries no CSRF header");

// 3. A present cookie is replayed (trimmed); a blank/whitespace one is dropped.
assertEqual(
  buildMeHeaders({ cookie: "  fluncle_user.session=abc  ", method: "GET" }).Cookie,
  "fluncle_user.session=abc",
  "cookie is trimmed and replayed",
);
assertEqual(
  buildMeHeaders({ cookie: "   ", method: "GET" }).Cookie,
  undefined,
  "blank cookie dropped",
);

// 4. A JSON mutation with a token attaches Content-Type + the CSRF header; a read with a
//    token attaches NEITHER content-type nor CSRF (the token is meaningless off a write).
const write = buildMeHeaders({ csrfToken: "tok-1", json: true, method: "POST" });
assertEqual(write["Content-Type"], "application/json", "JSON body → content-type");
assertEqual(write[CSRF_HEADER], "tok-1", "mutation attaches the CSRF token");
assertEqual(
  buildMeHeaders({ csrfToken: "tok-1", method: "GET" })[CSRF_HEADER],
  undefined,
  "a read never attaches CSRF even if a token is on hand",
);

// 5. A mutation with NO token omits the header (it will 403 server-side — the honest path).
assertEqual(
  buildMeHeaders({ json: true, method: "POST" })[CSRF_HEADER],
  undefined,
  "no token → no CSRF header",
);

// 6. Base headers are preserved and Origin still wins its slot.
const merged = buildMeHeaders({ base: { "X-Test": "1" }, method: "GET" });
assertEqual(merged["X-Test"], "1", "base header preserved");
assertEqual(merged.Origin, ME_ORIGIN, "Origin still stamped over a base");

// 7. Full integration through createMeFetch with a FAKE auth client + fetch: a READ makes
//    exactly one call (no CSRF round trip) carrying the cookie + origin.
type Call = { headers: Record<string, string>; method: string; url: string };

function fakeFetch(calls: Call[], csrfBody: unknown = { csrfToken: "srv-tok" }): typeof fetch {
  return (async (input: string, init?: MeInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ headers, method: (init?.method ?? "GET").toUpperCase(), url });

    if (url.endsWith(CSRF_ENDPOINT)) {
      return { json: async () => csrfBody, ok: true } as unknown as Response;
    }
    return { json: async () => ({ ok: true }), ok: true } as unknown as Response;
  }) as unknown as typeof fetch;
}

type MeInit = { body?: string; headers?: Record<string, string>; method?: string };

const readCalls: Call[] = [];
const readFetch = createMeFetch({
  baseUrl: "https://api.test",
  fetchImpl: fakeFetch(readCalls),
  getCookie: () => "sid=1",
});
await readFetch("/api/v1/me");
assertEqual(readCalls.length, 1, "a read makes exactly one call — no CSRF fetch");
assertEqual(readCalls[0]?.url, "https://api.test/api/v1/me", "read hits the base + path");
assertEqual(readCalls[0]?.headers.Cookie, "sid=1", "read carries the cookie");
assertEqual(readCalls[0]?.headers.Origin, ME_ORIGIN, "read carries the origin");
assertEqual(readCalls[0]?.headers[CSRF_HEADER], undefined, "read carries no CSRF");

// 8. A MUTATION first GETs the CSRF endpoint (with the cookie), then POSTs with the
//    server-issued token attached — the two-step every account slice relies on.
const writeCalls: Call[] = [];
const writeFetch = createMeFetch({
  baseUrl: "https://api.test",
  fetchImpl: fakeFetch(writeCalls),
  getCookie: () => "sid=9",
});
await writeFetch("/api/v1/me/delete", { body: "{}", method: "POST" });
assertEqual(writeCalls.length, 2, "a mutation makes two calls: CSRF then the write");
assertEqual(writeCalls[0]?.url, `https://api.test${CSRF_ENDPOINT}`, "first call is the CSRF fetch");
assertEqual(writeCalls[0]?.method, "GET", "CSRF fetch is a GET");
assertEqual(writeCalls[0]?.headers.Cookie, "sid=9", "CSRF fetch carries the cookie");
assertEqual(writeCalls[1]?.url, "https://api.test/api/v1/me/delete", "second call is the write");
assertEqual(writeCalls[1]?.method, "POST", "the write is a POST");
assertEqual(writeCalls[1]?.headers[CSRF_HEADER], "srv-tok", "the write attaches the server token");
assertEqual(writeCalls[1]?.headers["Content-Type"], "application/json", "the write is JSON");
assertEqual(writeCalls[1]?.headers.Cookie, "sid=9", "the write carries the cookie");

// 9. If the CSRF fetch fails (session gone), the write proceeds with NO token (server 403s).
const goneCalls: Call[] = [];
const goneFetch = createMeFetch({
  baseUrl: "https://api.test",
  fetchImpl: (async (input: string, init?: MeInit) => {
    const url = String(input);
    goneCalls.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: (init?.method ?? "GET").toUpperCase(),
      url,
    });
    if (url.endsWith(CSRF_ENDPOINT)) {
      return { json: async () => ({}), ok: false } as unknown as Response;
    }
    return { json: async () => ({}), ok: true } as unknown as Response;
  }) as unknown as typeof fetch,
  getCookie: () => "sid=x",
});
await goneFetch("/api/v1/me/delete", { body: "{}", method: "POST" });
assertEqual(
  goneCalls[1]?.headers[CSRF_HEADER],
  undefined,
  "a failed CSRF fetch → no token attached",
);

console.log("me-fetch.test.ts: all assertions passed");
