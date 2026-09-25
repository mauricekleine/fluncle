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

assertEqual(isMutation("post"), true, "POST is a mutation");
assertEqual(isMutation("DELETE"), true, "DELETE is a mutation");
assertEqual(isMutation("Patch"), true, "PATCH is a mutation");
assertEqual(isMutation("GET"), false, "GET is a read");
assertEqual(isMutation("head"), false, "HEAD is a read");

const read = buildMeHeaders({ method: "GET" });
assertEqual(read.Origin, ME_ORIGIN, "Origin is always stamped");
assertEqual(read.Cookie, undefined, "no cookie → no Cookie header");
assertEqual(read["Content-Type"], undefined, "a read carries no JSON content-type");
assertEqual(read[CSRF_HEADER], undefined, "a read carries no CSRF header");

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

const write = buildMeHeaders({ csrfToken: "tok-1", json: true, method: "POST" });
assertEqual(write["Content-Type"], "application/json", "JSON body → content-type");
assertEqual(write[CSRF_HEADER], "tok-1", "mutation attaches the CSRF token");
assertEqual(
  buildMeHeaders({ csrfToken: "tok-1", method: "GET" })[CSRF_HEADER],
  undefined,
  "a read never attaches CSRF even if a token is on hand",
);

assertEqual(
  buildMeHeaders({ json: true, method: "POST" })[CSRF_HEADER],
  undefined,
  "no token → no CSRF header",
);

const merged = buildMeHeaders({ base: { "X-Test": "1" }, method: "GET" });
assertEqual(merged["X-Test"], "1", "base header preserved");
assertEqual(merged.Origin, ME_ORIGIN, "Origin still stamped over a base");

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
