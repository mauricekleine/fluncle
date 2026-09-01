import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_POLICY,
  CONTENT_POLICY_WITH_REPORTING,
  REPORTING_ENDPOINTS_VALUE,
} from "./lib/server/security-headers";

// The production fetch dispatch SPINE (server.ts). server.ts composes the Worker's
// one fetch handler: `handleOrpc` mounted AHEAD of `handleMcp` AHEAD of
// `handleAgentDiscovery` AHEAD of the edge-cache wrapper + the TanStack router, all
// wrapped once by Sentry. No test drove that COMPOSITION before — a mount-order
// regression (oRPC no longer first, MCP shadowed, the router captured an /api path)
// would break the whole surface at once with every unit still green. This asserts
// the dispatch DECISIONS with real Requests.
//
// Seams:
//   - `@tanstack/react-start/server-entry` is stubbed: `createServerEntry` becomes a
//     passthrough that just exposes the composed `fetch`, and the default `handler`
//     (the TanStack ROUTER) is a spy — the fall-through target. Fully rendering an
//     SSR page in node is impractical and not the point; the load-bearing assertion
//     is WHICH handler a request is dispatched to, so the router is a sentinel.
//   - `@sentry/cloudflare`'s `withSentry` is a passthrough, so the module's default
//     export is the bare composed CF handler (`cfHandler`) — importable + callable
//     with just a Request, no Worker env/ctx. Sentry adds observability, not
//     dispatch, so removing it changes no routing behaviour. (This is why NO named
//     export had to be added to server.ts — the default is already drivable.)
//   - `handleMcp` / `handleAgentDiscovery` are spies, so the ORDER among the
//     null-returning stages is provable in isolation. `handleOrpc` is kept REAL, so
//     one test proves the actual contract dispatcher genuinely serves an /api op and
//     the router never sees it. Edge-cache is real too (it no-ops to `render()`
//     outside the Workers runtime — no `caches` global — so a cacheable GET still
//     lands on the router).
//
// NOTE — subdomain rewrites are NOT part of server.ts: the host→route rewrite runs
// isomorphically in the router's rewrite config (`router-rewrite.ts`), covered by
// router-rewrite.test.ts, exactly as server.ts's own comment says. So this suite
// asserts the dispatch stages server.ts actually owns and does not restate that one.

const hoisted = vi.hoisted(() => {
  // A FRESH response per call (a Response body streams once) so tests that read the
  // router body never contend over a shared, already-consumed stream.
  const makeRouterResponse = () =>
    new Response("router-sentinel", { headers: { "content-type": "text/html" }, status: 200 });

  return {
    handleAgentDiscovery: vi.fn(
      async (_request: Request): Promise<Response | undefined> => undefined,
    ),
    handleMcp: vi.fn(async (_request: Request): Promise<Response | undefined> => undefined),
    makeRouterResponse,
    routerFetch: vi.fn(async (_request: Request) => makeRouterResponse()),
  };
});

vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (options: { fetch: (request: Request) => Promise<Response> }) => ({
    fetch: (request: Request) => options.fetch(request),
  }),
  default: { fetch: hoisted.routerFetch },
}));

vi.mock("./lib/server/mcp", () => ({
  handleMcp: hoisted.handleMcp,
  // agent-discovery.ts derives its SKILL.md tool list from this at import time; the routing tests
  // never read that list, so an empty set keeps the module importable without pulling the real MCP.
  mcpToolNames: [],
}));

vi.mock("./lib/server/agent-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/server/agent-discovery")>();

  return {
    ...actual,
    // The header-append helpers stay pure passthroughs so a fall-through response is
    // returned identifiably; only the discovery DISPATCH stage is spied.
    appendAgentLinkHeaders: (response: Response) => response,
    appendOnionLocation: (response: Response) => response,
    handleAgentDiscovery: hoisted.handleAgentDiscovery,
  };
});

// The composed CF handler — server.ts's default export, unwrapped by the Sentry
// passthrough above. Typed as a Worker `ExportedHandler` (fetch is 3-arg + optional);
// cast to the single-arg shape the composed `cfHandler.fetch` actually implements (it
// reads only the Request — env/ctx come from the Cloudflare vite binding, see
// server.ts), so the test drives it with just a Request.
const worker = (await import("./server")).default as unknown as {
  fetch: (request: Request) => Promise<Response>;
};

function dispatch(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(url, { headers, method: "GET" }));
}

beforeEach(() => {
  hoisted.handleMcp.mockReset();
  hoisted.handleMcp.mockResolvedValue(undefined);
  hoisted.handleAgentDiscovery.mockReset();
  hoisted.handleAgentDiscovery.mockResolvedValue(undefined);
  hoisted.routerFetch.mockReset();
  hoisted.routerFetch.mockImplementation(async () => hoisted.makeRouterResponse());
});

describe("server.ts dispatch spine", () => {
  it("serves an /api contract path from the REAL handleOrpc — the router never sees it", async () => {
    // `/api/v1/search?q=a` faults in the real oRPC validator (too-short query) with no
    // DB touch — proof the contract dispatcher itself handled the request first.
    const response = await dispatch("https://www.fluncle.com/api/v1/search?q=a");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_query",
      message: "Search query must be at least 2 characters",
      ok: false,
    });
    // oRPC won: none of the later stages were consulted.
    expect(hoisted.handleMcp).not.toHaveBeenCalled();
    expect(hoisted.handleAgentDiscovery).not.toHaveBeenCalled();
    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("routes an MCP request to handleMcp (mounted after oRPC, before discovery + router)", async () => {
    const mcpResponse = new Response("mcp", { status: 200 });
    hoisted.handleMcp.mockResolvedValueOnce(mcpResponse);

    const response = await dispatch("https://www.fluncle.com/mcp");

    // handleOrpc (real) returned null for this non-/api path, so handleMcp answered.
    expect(response).toBe(mcpResponse);
    expect(hoisted.handleMcp).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).not.toHaveBeenCalled();
    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("routes an agent-discovery request to handleAgentDiscovery (after MCP, before the router)", async () => {
    const discoveryResponse = new Response("discovery", { status: 200 });
    hoisted.handleAgentDiscovery.mockResolvedValueOnce(discoveryResponse);

    const response = await dispatch("https://www.fluncle.com/.well-known/some-agent-doc");

    expect(response).toBe(discoveryResponse);
    expect(hoisted.handleMcp).toHaveBeenCalledTimes(1); // consulted, returned undefined
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);
    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("falls a non-contract path through to the TanStack router when every earlier stage passes", async () => {
    const response = await dispatch("https://www.fluncle.com/", { accept: "text/html" });

    // All three seams were consulted and declined, so the router rendered.
    expect(hoisted.handleMcp).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);
    expect(hoisted.routerFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("router-sentinel");
  });

  it("answers 406 (not the router's 500) when a public page is asked for in a shape it cannot take", async () => {
    // An API client or crawler asking a /log, /track, or hub URL for JSON: the router's SSR guard
    // would call that a 500. The archive did not fault, so the spine answers 406 and never
    // renders — and the JSON reply names where the same facts live.
    for (const path of ["/log/abc123", "/track/mb_abc", "/artist/netsky", "/tracks", "/"]) {
      const response = await dispatch(`https://www.fluncle.com${path}`, {
        accept: "application/json",
      });

      expect(response.status, path).toBe(406);
      expect(response.headers.get("vary"), path).toBe("Accept");
      expect((await response.json()) as { code: string }, path).toMatchObject({
        code: "not_acceptable",
        ok: false,
      });
    }

    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("still renders a public page for every Accept that admits HTML — including none at all", async () => {
    for (const accept of [
      undefined,
      "*/*",
      "text/*",
      "text/html;q=0.9, application/json",
      "application/json, */*;q=0.1",
    ]) {
      hoisted.routerFetch.mockClear();

      const response = await dispatch(
        "https://www.fluncle.com/log/abc123",
        accept === undefined ? {} : { accept },
      );

      expect(response.status, String(accept)).toBe(200);
      expect(await response.text(), String(accept)).toBe("router-sentinel");
      expect(hoisted.routerFetch, String(accept)).toHaveBeenCalledTimes(1);
    }
  });

  it("never negotiates a non-page path: the API, a feed, and a server function flow on untouched", async () => {
    // `/api/v1/tracks` is a real contract op (JSON is exactly what it answers); a feed and a server
    // function carry no HTML cache policy, so a JSON-only Accept reaches the router as before.
    for (const path of ["/rss.xml", "/_serverFn/abc", "/api/preview/x"]) {
      hoisted.routerFetch.mockClear();

      const response = await dispatch(`https://www.fluncle.com${path}`, {
        accept: "application/json",
      });

      expect(response.status, path).not.toBe(406);
      expect(hoisted.routerFetch, path).toHaveBeenCalledTimes(1);
    }
  });

  it("takes the edge-cache branch for a cacheable /log GET and still lands on the router (no oRPC/MCP capture)", async () => {
    // A public log path with an HTML Accept and no admin cookie is edge-cacheable;
    // outside the Workers runtime the cache no-ops straight to the router `render`,
    // so the request must still reach the router — never oRPC or MCP.
    const response = await dispatch("https://www.fluncle.com/log/abc123", { accept: "text/html" });

    expect(hoisted.routerFetch).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);
    // The router body was served (via withEdgeCache's render), not an oRPC/MCP frame.
    expect(await response.text()).toBe("router-sentinel");
  });
});

// The shared-cache ISOLATION guards, driven end to end through the real dispatch spine.
// Every one of these is a correctness rail rather than a performance knob: a miss stores
// a document under a key it will later be served from, so an admin view, a personalized
// response, or a query VARIANT landing in that store is a live bug (an operator's board
// handed to the public, or page 2's body served as page 1). The predicates are unit-pinned
// in lib/server/edge-cache.test.ts; what is proven HERE is that server.ts actually applies
// them — with a stand-in `caches.default` installed so "did it shared-cache?" is observable
// instead of silently no-opping the way the bare Node runtime does.
describe("server.ts shared-cache isolation", () => {
  let entries: Map<string, Response>;
  let previousCaches: unknown;

  beforeEach(() => {
    entries = new Map<string, Response>();
    const globals = globalThis as { caches?: unknown };
    previousCaches = globals.caches;
    globals.caches = {
      default: {
        delete: async (key: Request) => entries.delete(key.url),
        match: async (key: Request) => entries.get(key.url)?.clone(),
        put: async (key: Request, response: Response) => {
          entries.set(key.url, response);
        },
      },
    };
  });

  afterEach(() => {
    (globalThis as { caches?: unknown }).caches = previousCaches;
  });

  /** Dispatch, then let the `waitUntil`-extended `cache.put` settle before asserting. */
  async function dispatchAndSettle(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<void> {
    await dispatch(url, headers);
    await Promise.resolve();
    await Promise.resolve();
  }

  it("shared-caches a public hub GET under its canonical key", async () => {
    await dispatchAndSettle("https://www.fluncle.com/artists", { accept: "text/html" });

    expect([...entries.keys()]).toEqual(["https://www.fluncle.com/artists"]);
  });

  it("NEVER shared-caches an admin view", async () => {
    // The presence of the admin grant cookie is enough to bypass: an operator must always
    // see live data, and their rendered document must never become the public's copy.
    await dispatchAndSettle("https://www.fluncle.com/artists", {
      accept: "text/html",
      cookie: "fluncle_admin=some-grant; other=1",
    });
    await dispatchAndSettle("https://www.fluncle.com/log/abc123", {
      accept: "text/html",
      cookie: "fluncle_admin=some-grant",
    });

    expect(entries.size).toBe(0);
  });

  it("NEVER shared-caches a query variant that would collide onto the canonical entry", async () => {
    // The cache key drops every query EXCEPT a lone `?page=N` on a paginated hub (proven
    // below). So these must all flow through uncached, or a cached body would be served back
    // for the wrong URL:
    //  - a non-`page` param on a hub (`?galaxy=`);
    //  - `?page=2` on an ENTITY DETAIL page — not a paginated hub, so it must still be refused;
    //  - a NON-LONE page (`?page=2&q=x`) and a NON-NUMERIC page (`?page=abc`) on a paginated
    //    hub — the guard only accepts a lone positive integer.
    await dispatchAndSettle("https://www.fluncle.com/tracks?galaxy=drift", {
      accept: "text/html",
    });
    await dispatchAndSettle("https://www.fluncle.com/artist/sub-focus?page=2", {
      accept: "text/html",
    });
    await dispatchAndSettle("https://www.fluncle.com/artists?page=2&q=x", {
      accept: "text/html",
    });
    await dispatchAndSettle("https://www.fluncle.com/artists?page=abc", {
      accept: "text/html",
    });

    expect(entries.size).toBe(0);
  });

  it("shared-caches a paginated hub's ?page=N under its OWN distinct key (never colliding onto page 1)", async () => {
    // The positive half of the contract, at the dispatch layer where a lone `?page=N`
    // lived: a lone `?page=N` on a paginated catalogue hub IS cacheable, folded into the key as
    // the parsed page, so page 2 and page 3 are distinct entries and neither can serve page 1's
    // body back (the collision-safety property).
    await dispatchAndSettle("https://www.fluncle.com/artists?page=2", { accept: "text/html" });
    await dispatchAndSettle("https://www.fluncle.com/artists?page=3", { accept: "text/html" });

    expect(new Set(entries.keys())).toEqual(
      new Set(["https://www.fluncle.com/artists?page=2", "https://www.fluncle.com/artists?page=3"]),
    );

    // A repeat hit on page 2 serves ITS stored body — never page 3's, never page 1's.
    const page2Key = new Request("https://www.fluncle.com/artists?page=2");
    const stored = await entries.get(page2Key.url)?.clone()?.text();
    const refetched = await dispatch("https://www.fluncle.com/artists?page=2", {
      accept: "text/html",
    });

    expect(refetched.headers.get("x-edge-cache")).toBe("fresh");
    expect(await refetched.text()).toBe(stored);
  });

  it("NEVER shared-caches a non-HTML request or a non-GET", async () => {
    // A non-HTML Accept is a data client, not a page view; a mutation is never cacheable.
    await dispatchAndSettle("https://www.fluncle.com/artists", { accept: "application/json" });
    await worker.fetch(
      new Request("https://www.fluncle.com/artists", {
        headers: { accept: "text/html" },
        method: "POST",
      }),
    );
    await Promise.resolve();

    expect(entries.size).toBe(0);
  });

  it("NEVER shared-caches an account or admin surface", async () => {
    for (const path of ["/account", "/admin", "/admin/tracks", "/recommendations", "/chat"]) {
      await dispatchAndSettle(`https://www.fluncle.com${path}`, { accept: "text/html" });
    }

    expect(entries.size).toBe(0);
  });

  // The security headers ride the way OUT, not the cached body — so a cache HIT (a
  // document rendered and stored minutes ago) must carry today's policy just like a cold
  // miss. This is the whole reason the layer sits outside `withEdgeCache`: baked into the
  // stored response, a policy change would only take effect after the stale tail drained.
  it("stamps the security headers on a cache HIT, not just the cold render", async () => {
    const miss = await dispatch("https://www.fluncle.com/artists", { accept: "text/html" });

    expect(miss.headers.get("x-edge-cache")).toBe("miss");
    expect(miss.headers.get("x-content-type-options")).toBe("nosniff");
    await Promise.resolve();
    await Promise.resolve();

    const hit = await dispatch("https://www.fluncle.com/artists", { accept: "text/html" });

    expect(hit.headers.get("x-edge-cache")).toBe("fresh");
    expect(hit.headers.get("x-content-type-options")).toBe("nosniff");
    expect(hit.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(hit.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(hit.headers.get("content-security-policy")).toBe(CONTENT_POLICY_WITH_REPORTING);
    expect(hit.headers.get("content-security-policy-report-only")).toBeNull();
    expect(hit.headers.get("reporting-endpoints")).toBe(REPORTING_ENDPOINTS_VALUE);
    // The stored body itself is unstamped — the policy is applied per response, so it is
    // never frozen at the age of the cached document.
    expect(
      entries.get("https://www.fluncle.com/artists")?.headers.get("content-security-policy"),
    ).toBeNull();
  });
});

// The security-header layer, driven through the REAL dispatch spine — the point being
// that no branch escapes it: an oRPC contract reply, an MCP/discovery frame, a
// non-HTML file-route emitter, an SSR document, and a route that owns its own CSP all
// leave through the same wrap. The policy itself is unit-pinned in
// lib/server/security-headers.test.ts.
describe("server.ts security headers", () => {
  it("puts nosniff on the REAL oRPC JSON reply (a contract op never escapes the layer)", async () => {
    const response = await dispatch("https://www.fluncle.com/api/v1/search?q=a");

    expect(response.status).toBe(400);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // A JSON reply is not a document: no framing, referrer or transport header on it.
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBeNull();
    expect(response.headers.get("strict-transport-security")).toBeNull();
    // The body is untouched by the layer.
    expect(await response.json()).toEqual({
      code: "invalid_query",
      message: "Search query must be at least 2 characters",
      ok: false,
    });
  });

  it("gives an SSR HTML document the full document header set", async () => {
    const response = await dispatch("https://www.fluncle.com/about", { accept: "text/html" });

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_POLICY_WITH_REPORTING);
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    // The CSP report sink, wired end to end: an SSR document tells the browser where to
    // POST a violation. Now that the policy ENFORCES, that is the only way a block
    // reaching a real visitor is ever noticed — there is no runtime kill switch.
    expect(response.headers.get("reporting-endpoints")).toBe(REPORTING_ENDPOINTS_VALUE);
    expect(await response.text()).toBe("router-sentinel");
  });

  it("leaves a NON-HTML file-route emitter (a feed) with nosniff only — and intact", async () => {
    // `/feed.xml`, the sitemap, robots, llms.txt, the OG images: file-route carve-outs
    // that emit non-JSON, non-HTML bodies. Double-setting a document header on one of
    // these is how a feed reader gets a surprise, so the layer must add nothing but
    // nosniff and must not disturb the content type or the body.
    hoisted.routerFetch.mockImplementationOnce(
      async () =>
        new Response('<?xml version="1.0"?><rss/>', {
          headers: { "cache-control": "public, max-age=600", "content-type": "application/xml" },
        }),
    );

    const response = await dispatch("https://www.fluncle.com/feed.xml");

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("application/xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBeNull();
    expect(await response.text()).toBe('<?xml version="1.0"?><rss/>');
  });

  it("keeps the embed route's permissive frame-ancestors — the exemption survives the spine", async () => {
    // The oEmbed card is the one route that declares its own CSP so third parties may
    // frame it. Standing in for it here (the real route pulls the log resolver) proves
    // the spine-level behaviour: an existing CSP is neither replaced by `'self'` nor
    // shadowed by a report-only header, while nosniff/referrer/HSTS still apply.
    hoisted.routerFetch.mockImplementationOnce(
      async () =>
        new Response("<!doctype html><html>card</html>", {
          headers: {
            "content-security-policy": "frame-ancestors *",
            "content-type": "text/html; charset=utf-8",
          },
        }),
    );

    const response = await dispatch("https://www.fluncle.com/embed/001.A.01", {
      accept: "text/html",
    });

    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors *");
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("stamps an MCP frame and a discovery doc too (no stage bypasses the wrap)", async () => {
    hoisted.handleMcp.mockResolvedValueOnce(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    const mcp = await dispatch("https://www.fluncle.com/mcp");

    expect(mcp.headers.get("x-content-type-options")).toBe("nosniff");

    hoisted.handleAgentDiscovery.mockResolvedValueOnce(
      new Response("# skill", { headers: { "content-type": "text/markdown" } }),
    );
    const discovery = await dispatch("https://www.fluncle.com/.well-known/agent");

    expect(discovery.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does NOT pin HSTS on a plain-http request (local dev, and the Tor mirror)", async () => {
    const response = await dispatch("http://localhost:3000/about", { accept: "text/html" });

    expect(response.headers.get("strict-transport-security")).toBeNull();
    // Dev gets the identical DIRECTIVES but stays advisory: vite binds 127.0.0.1 while
    // most people browse localhost, and CSP treats those as different origins, so
    // enforcing connect-src 'self' would refuse the HMR websocket. The sink is withheld
    // too, so a dev session never writes into the production Security feed.
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toBe(CONTENT_POLICY);
    expect(response.headers.get("reporting-endpoints")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
